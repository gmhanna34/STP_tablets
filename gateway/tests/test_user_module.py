"""Tests for user_module — CRUD, password hashing, authentication."""

import os
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from user_module import UserModule


@pytest.fixture
def user_mod():
    """Create a UserModule with a temp YAML file."""
    fd, path = tempfile.mkstemp(suffix=".yaml")
    os.close(fd)
    os.unlink(path)  # Let UserModule create it
    mod = UserModule(path)
    yield mod
    try:
        os.unlink(path)
    except OSError:
        pass


class TestUserCRUD:
    def test_create_user(self, user_mod):
        user = user_mod.create_user("john", "John Smith", "pass1234", "full_access")
        assert user["username"] == "john"
        assert user["display_name"] == "John Smith"
        assert user["role"] == "full_access"
        assert user["enabled"] is True

    def test_create_user_normalizes_username(self, user_mod):
        user = user_mod.create_user("  JOHN  ", "John", "pass1234")
        assert user["username"] == "john"

    def test_create_duplicate_raises(self, user_mod):
        user_mod.create_user("john", "John", "pass1234")
        with pytest.raises(ValueError, match="already exists"):
            user_mod.create_user("john", "John2", "pass5678")

    def test_create_short_username_raises(self, user_mod):
        with pytest.raises(ValueError, match="at least 3"):
            user_mod.create_user("ab", "AB", "pass1234")

    def test_create_empty_username_raises(self, user_mod):
        with pytest.raises(ValueError, match="cannot be empty"):
            user_mod.create_user("", "Empty", "pass1234")

    def test_create_invalid_chars_raises(self, user_mod):
        with pytest.raises(ValueError, match="letters, numbers"):
            user_mod.create_user("john doe", "John", "pass1234")

    def test_create_short_password_raises(self, user_mod):
        with pytest.raises(ValueError, match="at least 4"):
            user_mod.create_user("john", "John", "abc")

    def test_list_users(self, user_mod):
        user_mod.create_user("alice", "Alice", "pass1234", "chapel")
        user_mod.create_user("bob", "Bob", "pass5678", "full_access")
        users = user_mod.list_users()
        assert len(users) == 2
        assert users[0]["username"] == "alice"
        assert users[1]["username"] == "bob"
        # Should not contain password hashes
        for u in users:
            assert "password_hash" not in u

    def test_get_user(self, user_mod):
        user_mod.create_user("john", "John", "pass1234", "chapel")
        user = user_mod.get_user("john")
        assert user is not None
        assert user["username"] == "john"
        assert user["role"] == "chapel"
        assert "password_hash" in user  # get_user includes hash (internal use)

    def test_get_nonexistent_user(self, user_mod):
        assert user_mod.get_user("nobody") is None

    def test_update_user(self, user_mod):
        user_mod.create_user("john", "John", "pass1234", "chapel")
        updated = user_mod.update_user("john", role="full_access", display_name="John D.")
        assert updated["role"] == "full_access"
        assert updated["display_name"] == "John D."

    def test_update_nonexistent_raises(self, user_mod):
        with pytest.raises(ValueError, match="not found"):
            user_mod.update_user("nobody", role="full_access")

    def test_update_enabled(self, user_mod):
        user_mod.create_user("john", "John", "pass1234")
        updated = user_mod.update_user("john", enabled=False)
        assert updated["enabled"] is False

    def test_delete_user(self, user_mod):
        user_mod.create_user("john", "John", "pass1234")
        user_mod.delete_user("john")
        assert user_mod.get_user("john") is None

    def test_delete_nonexistent_raises(self, user_mod):
        with pytest.raises(ValueError, match="not found"):
            user_mod.delete_user("nobody")

    def test_reset_password(self, user_mod):
        user_mod.create_user("john", "John", "oldpass1")
        user_mod.reset_password("john", "newpass1")
        # Old password should no longer work
        assert user_mod.authenticate("john", "oldpass1") is None
        # New password should work
        result = user_mod.authenticate("john", "newpass1")
        assert result is not None
        assert result["username"] == "john"

    def test_reset_password_short_raises(self, user_mod):
        user_mod.create_user("john", "John", "pass1234")
        with pytest.raises(ValueError, match="at least 4"):
            user_mod.reset_password("john", "ab")


class TestPasswordHashing:
    def test_hash_and_verify(self):
        hashed = UserModule.hash_password("test1234")
        assert hashed.startswith("$2b$")
        assert UserModule.verify_password("test1234", hashed) is True
        assert UserModule.verify_password("wrong", hashed) is False

    def test_verify_bad_hash(self):
        assert UserModule.verify_password("test", "not-a-hash") is False


class TestAuthentication:
    def test_authenticate_success(self, user_mod):
        user_mod.create_user("john", "John Smith", "mypass123", "chapel")
        result = user_mod.authenticate("john", "mypass123")
        assert result is not None
        assert result["username"] == "john"
        assert result["display_name"] == "John Smith"
        assert result["role"] == "chapel"
        # Should not contain password hash
        assert "password_hash" not in result

    def test_authenticate_wrong_password(self, user_mod):
        user_mod.create_user("john", "John", "mypass123")
        assert user_mod.authenticate("john", "wrongpass") is None

    def test_authenticate_nonexistent_user(self, user_mod):
        assert user_mod.authenticate("nobody", "pass") is None

    def test_authenticate_disabled_user(self, user_mod):
        user_mod.create_user("john", "John", "mypass123")
        user_mod.update_user("john", enabled=False)
        assert user_mod.authenticate("john", "mypass123") is None

    def test_authenticate_empty_credentials(self, user_mod):
        assert user_mod.authenticate("", "") is None
        assert user_mod.authenticate("john", "") is None
        assert user_mod.authenticate("", "pass") is None

    def test_authenticate_case_insensitive_username(self, user_mod):
        user_mod.create_user("john", "John", "mypass123")
        result = user_mod.authenticate("JOHN", "mypass123")
        assert result is not None
        assert result["username"] == "john"


class TestYAMLPersistence:
    def test_data_survives_reload(self, user_mod):
        user_mod.create_user("john", "John", "pass1234", "chapel")
        # Create a new UserModule pointing to the same file
        mod2 = UserModule(user_mod._path)
        user = mod2.get_user("john")
        assert user is not None
        assert user["display_name"] == "John"
        assert user["role"] == "chapel"

    def test_empty_file_creation(self):
        fd, path = tempfile.mkstemp(suffix=".yaml")
        os.close(fd)
        os.unlink(path)
        mod = UserModule(path)
        assert os.path.isfile(path)
        assert mod.list_users() == []
        os.unlink(path)
