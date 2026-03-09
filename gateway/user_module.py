"""User management module — CRUD operations with bcrypt password hashing.

Users are stored in a YAML file (users.yaml) alongside config.yaml and macros.yaml.
Each user has a username, display name, bcrypt-hashed password, role, and enabled flag.
Roles reference the same permission roles defined in permissions.json.
"""

from __future__ import annotations

import logging
import os
import threading
from typing import Any, Dict, List, Optional

import bcrypt
import yaml

logger = logging.getLogger("stp-gateway")

# Thread lock for safe concurrent YAML read/write
_file_lock = threading.Lock()


class UserModule:
    """Manages user accounts stored in users.yaml."""

    def __init__(self, yaml_path: str):
        self._path = yaml_path
        self._ensure_file()

    def _ensure_file(self):
        """Create users.yaml with empty users dict if it doesn't exist."""
        if not os.path.isfile(self._path):
            with _file_lock:
                if not os.path.isfile(self._path):
                    with open(self._path, "w") as f:
                        yaml.safe_dump({"users": {}}, f)
                    logger.info(f"Created empty users file: {self._path}")

    def _load(self) -> dict:
        """Load and return the full YAML data."""
        with _file_lock:
            with open(self._path, "r") as f:
                data = yaml.safe_load(f) or {}
        return data

    def _save(self, data: dict):
        """Write the full YAML data back to disk."""
        with _file_lock:
            with open(self._path, "w") as f:
                yaml.safe_dump(data, f, default_flow_style=False, sort_keys=False)

    @staticmethod
    def hash_password(password: str) -> str:
        """Hash a plaintext password with bcrypt."""
        return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")

    @staticmethod
    def verify_password(password: str, password_hash: str) -> bool:
        """Check a plaintext password against a bcrypt hash."""
        try:
            return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
        except Exception:
            return False

    def get_user(self, username: str) -> Optional[Dict[str, Any]]:
        """Get a single user by username. Returns None if not found."""
        data = self._load()
        users = data.get("users", {})
        user = users.get(username)
        if user is None:
            return None
        return {"username": username, **user}

    def list_users(self) -> List[Dict[str, Any]]:
        """List all users (without password hashes)."""
        data = self._load()
        users = data.get("users", {})
        result = []
        for username, info in users.items():
            result.append({
                "username": username,
                "display_name": info.get("display_name", username),
                "role": info.get("role", "full_access"),
                "enabled": info.get("enabled", True),
            })
        return result

    def create_user(self, username: str, display_name: str, password: str,
                    role: str = "full_access") -> Dict[str, Any]:
        """Create a new user. Raises ValueError if username already exists or is invalid."""
        username = username.strip().lower()
        if not username:
            raise ValueError("Username cannot be empty")
        if len(username) < 3:
            raise ValueError("Username must be at least 3 characters")
        if len(username) > 32:
            raise ValueError("Username must be at most 32 characters")
        if not username.replace("_", "").replace("-", "").isalnum():
            raise ValueError("Username may only contain letters, numbers, hyphens, and underscores")
        if not password or len(password) < 4:
            raise ValueError("Password must be at least 4 characters")

        data = self._load()
        users = data.setdefault("users", {})
        if username in users:
            raise ValueError(f"User '{username}' already exists")

        users[username] = {
            "display_name": display_name or username,
            "password_hash": self.hash_password(password),
            "role": role,
            "enabled": True,
        }
        self._save(data)
        logger.info(f"Created user: {username} (role={role})")
        return {"username": username, "display_name": display_name, "role": role, "enabled": True}

    def update_user(self, username: str, **fields) -> Dict[str, Any]:
        """Update user fields (display_name, role, enabled). Raises ValueError if not found."""
        data = self._load()
        users = data.get("users", {})
        if username not in users:
            raise ValueError(f"User '{username}' not found")

        allowed = {"display_name", "role", "enabled"}
        for key, value in fields.items():
            if key in allowed:
                users[username][key] = value

        self._save(data)
        logger.info(f"Updated user: {username} (fields={list(fields.keys())})")
        return {
            "username": username,
            "display_name": users[username].get("display_name", username),
            "role": users[username].get("role", "full_access"),
            "enabled": users[username].get("enabled", True),
        }

    def reset_password(self, username: str, new_password: str):
        """Reset a user's password. Raises ValueError if not found or password too short."""
        if not new_password or len(new_password) < 4:
            raise ValueError("Password must be at least 4 characters")

        data = self._load()
        users = data.get("users", {})
        if username not in users:
            raise ValueError(f"User '{username}' not found")

        users[username]["password_hash"] = self.hash_password(new_password)
        self._save(data)
        logger.info(f"Password reset for user: {username}")

    def delete_user(self, username: str):
        """Delete a user. Raises ValueError if not found."""
        data = self._load()
        users = data.get("users", {})
        if username not in users:
            raise ValueError(f"User '{username}' not found")

        del users[username]
        self._save(data)
        logger.info(f"Deleted user: {username}")

    def authenticate(self, username: str, password: str) -> Optional[Dict[str, Any]]:
        """Authenticate a user. Returns user dict (without hash) if valid, None otherwise."""
        username = (username or "").strip().lower()
        if not username or not password:
            return None

        user = self.get_user(username)
        if user is None:
            return None
        if not user.get("enabled", True):
            return None
        if not self.verify_password(password, user.get("password_hash", "")):
            return None

        return {
            "username": user["username"],
            "display_name": user.get("display_name", username),
            "role": user.get("role", "full_access"),
        }
