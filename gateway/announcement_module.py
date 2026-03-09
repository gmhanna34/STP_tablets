"""Announcement module — TTS generation, WiiM playback, and sequence execution."""

from __future__ import annotations

import hashlib
import logging
import os
import subprocess
import tempfile
import threading
import time
from typing import Any, Dict, List, Optional

import requests as http_requests
import yaml

logger = logging.getLogger("stp-gateway")

# Voices that are known to fail with edge-tts
_BLOCKED_VOICES = {"en-US-JaneNeural"}

# Default voice options shown in the UI (order matters — first is default)
DEFAULT_VOICES = [
    {"id": "en-US-AndrewNeural", "name": "Andrew", "gender": "Male", "locale": "US"},
    {"id": "en-US-GuyNeural", "name": "Guy", "gender": "Male", "locale": "US"},
    {"id": "en-US-JennyNeural", "name": "Jenny", "gender": "Female", "locale": "US"},
    {"id": "en-US-AriaNeural", "name": "Aria", "gender": "Female", "locale": "US"},
    {"id": "en-US-DavisNeural", "name": "Davis", "gender": "Male", "locale": "US"},
    {"id": "en-GB-RyanNeural", "name": "Ryan", "gender": "Male", "locale": "UK"},
    {"id": "en-GB-SoniaNeural", "name": "Sonia", "gender": "Female", "locale": "UK"},
]


class AnnouncementModule:
    """Manages TTS announcements: presets, sequences, and custom text."""

    def __init__(self, cfg: dict, logger_inst, ctx=None):
        self.cfg = cfg
        self.logger = logger_inst
        self.ctx = ctx
        self._ann_cfg = {}
        self._presets = {}
        self._sequences = {}
        self._defaults = {}

        # TTS audio cache
        self._cache = {}
        self._cache_lock = threading.Lock()
        self._CACHE_MAX = 20
        self._CACHE_TTL = 300  # 5 minutes

        # Active sequence tracking (for cancellation)
        self._active_sequences = {}  # key -> threading.Event (cancel flag)
        self._seq_lock = threading.Lock()

        self._load_config()

    def _load_config(self):
        """Load announcements.yaml."""
        ann_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "announcements.yaml")
        try:
            with open(ann_path, "r") as f:
                self._ann_cfg = yaml.safe_load(f) or {}
        except Exception as e:
            self.logger.warning(f"Could not load announcements.yaml: {e}")
            self._ann_cfg = {}

        self._defaults = self._ann_cfg.get("defaults", {})
        self._presets = self._ann_cfg.get("presets", {})
        self._sequences = self._ann_cfg.get("sequences", {})
        self.logger.info(f"Announcements loaded: {len(self._presets)} presets, "
                         f"{len(self._sequences)} sequences")

    def reload_config(self):
        """Reload announcements.yaml (e.g., after editing)."""
        self._load_config()

    @property
    def default_voice(self) -> str:
        return self._defaults.get("voice", "en-US-AndrewNeural")

    @property
    def wiim_entity(self) -> str:
        return self._defaults.get("wiim_entity", "media_player.wiim_pro_new")

    @property
    def announce_mode(self) -> bool:
        return self._defaults.get("announce_mode", True)

    @property
    def unmute_aux_channels(self) -> list:
        return self._defaults.get("unmute_aux", [3, 4])

    def get_presets(self) -> dict:
        """Return all preset definitions."""
        return self._presets

    def get_sequences(self) -> dict:
        """Return all sequence definitions."""
        return self._sequences

    def get_config_summary(self) -> dict:
        """Return full config for the frontend."""
        return {
            "defaults": self._defaults,
            "presets": self._presets,
            "sequences": self._sequences,
            "voices": DEFAULT_VOICES,
        }

    # ---- TTS Generation ----

    def generate_tts(self, message: str, voice: str = None) -> dict:
        """Generate TTS audio via edge-tts. Returns {url, size, voice} or {error}."""
        if not message.strip():
            return {"error": "message is required"}

        voice = voice or self.default_voice
        if voice in _BLOCKED_VOICES:
            return {"error": f"Voice {voice} is not supported. Please choose a different voice."}

        try:
            with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp:
                tmp_path = tmp.name

            try:
                result = subprocess.run(
                    ["edge-tts", "--voice", voice, "--text", message, "--write-media", tmp_path],
                    capture_output=True, text=True, timeout=30,
                )
                if result.returncode != 0:
                    return {"error": f"edge-tts failed: {result.stderr[:300]}"}

                with open(tmp_path, "rb") as f:
                    audio_bytes = f.read()
            finally:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass

            if not audio_bytes or len(audio_bytes) < 100:
                return {"error": "edge-tts returned empty/invalid audio"}

            # Cache the audio
            filename = hashlib.md5(
                (message + voice + str(time.time())).encode()
            ).hexdigest() + ".mp3"

            with self._cache_lock:
                now = time.time()
                expired = [k for k, v in self._cache.items() if now - v["created"] > self._CACHE_TTL]
                for k in expired:
                    del self._cache[k]
                while len(self._cache) >= self._CACHE_MAX:
                    oldest = min(self._cache, key=lambda k: self._cache[k]["created"])
                    del self._cache[oldest]
                self._cache[filename] = {
                    "bytes": audio_bytes,
                    "created": now,
                    "content_type": "audio/mpeg",
                }

            url = f"/api/tts/audio/{filename}"
            self.logger.info("TTS generated: %s (%d bytes, voice=%s) -> %s",
                             message[:50], len(audio_bytes), voice, url)
            return {"url": url, "size": len(audio_bytes), "voice": voice}

        except FileNotFoundError:
            return {"error": "edge-tts CLI not found. Run: pip install edge-tts"}
        except subprocess.TimeoutExpired:
            return {"error": "edge-tts timed out (30s)"}
        except Exception as e:
            self.logger.error("TTS generate error: %s", e)
            return {"error": str(e)}

    def get_cached_audio(self, filename: str) -> Optional[dict]:
        """Return cached audio entry {bytes, content_type} or None."""
        with self._cache_lock:
            return self._cache.get(filename)

    # ---- WiiM Playback ----

    def play_on_wiim(self, audio_url: str, announce: bool = None) -> dict:
        """Play audio URL on WiiM via HA media_player.play_media."""
        if announce is None:
            announce = self.announce_mode

        ha_cfg = self._get_ha_cfg()
        if not ha_cfg.get("url") or not ha_cfg.get("token"):
            return {"error": "Home Assistant not configured"}

        play_data = {
            "entity_id": self.wiim_entity,
            "media_content_id": audio_url,
            "media_content_type": "music",
        }
        if announce:
            play_data["announce"] = True

        try:
            resp = http_requests.post(
                f"{ha_cfg['url']}/api/services/media_player/play_media",
                headers={
                    "Authorization": f"Bearer {ha_cfg['token']}",
                    "Content-Type": "application/json",
                },
                json=play_data,
                timeout=ha_cfg.get("timeout", 10),
            )
            if resp.status_code < 400:
                return {"success": True}
            return {"error": f"HA play_media returned {resp.status_code}"}
        except Exception as e:
            return {"error": f"WiiM playback failed: {e}"}

    # ---- Pre-announce Actions ----

    def pre_announce(self) -> None:
        """Unmute X32 aux channels before announcing."""
        if not self.ctx or not self.ctx.x32:
            return
        for aux_ch in self.unmute_aux_channels:
            try:
                self.ctx.x32.mute_aux(aux_ch, "off")
            except Exception as e:
                self.logger.debug(f"Pre-announce unmute aux {aux_ch} failed: {e}")

    # ---- Single Announcement ----

    def announce_text(self, text: str, voice: str = None, gateway_origin: str = "") -> dict:
        """Generate TTS and play on WiiM. Returns result dict."""
        self.pre_announce()

        gen_result = self.generate_tts(text, voice)
        if "error" in gen_result:
            return gen_result

        audio_url = gateway_origin + gen_result["url"]
        play_result = self.play_on_wiim(audio_url)
        if "error" in play_result:
            return play_result

        return {
            "success": True,
            "text": text,
            "voice": gen_result["voice"],
            "audio_url": gen_result["url"],
            "size": gen_result["size"],
        }

    # ---- Preset Announcement ----

    def announce_preset(self, preset_key: str, voice: str = None,
                        gateway_origin: str = "") -> dict:
        """Play a preset announcement by key."""
        preset = self._presets.get(preset_key)
        if not preset:
            return {"error": f"Unknown preset: {preset_key}"}

        text = preset.get("text", "")
        if not text:
            return {"error": f"Preset {preset_key} has no text"}

        result = self.announce_text(text, voice, gateway_origin)
        if result.get("success"):
            result["preset"] = preset_key
            result["label"] = preset.get("label", preset_key)
        return result

    # ---- Sequence Execution ----

    def run_sequence(self, sequence_key: str, voice: str = None,
                     gateway_origin: str = "", tablet: str = "") -> dict:
        """Execute a multi-step announcement sequence. Blocks until complete or cancelled."""
        seq = self._sequences.get(sequence_key)
        if not seq:
            return {"error": f"Unknown sequence: {sequence_key}"}

        steps = seq.get("steps", [])
        if not steps:
            return {"error": f"Sequence {sequence_key} has no steps"}

        label = seq.get("label", sequence_key)
        cancel_event = threading.Event()

        with self._seq_lock:
            # Cancel any existing run of this sequence
            old = self._active_sequences.get(sequence_key)
            if old:
                old.set()
            self._active_sequences[sequence_key] = cancel_event

        socketio = self.ctx.socketio if self.ctx else None

        def _broadcast(status, step_idx=0, step_msg="", error="", **extra):
            if not socketio:
                return
            data = {
                "type": "sequence",
                "sequence": sequence_key,
                "label": label,
                "status": status,
                "tablet": tablet,
                "steps_total": len(steps),
                "steps_completed": step_idx,
                "current_step": step_msg,
            }
            if error:
                data["error"] = error
            data.update(extra)
            socketio.emit("announce:progress", data)

        _broadcast("started")
        self.pre_announce()

        completed = 0
        for i, step in enumerate(steps):
            if cancel_event.is_set():
                _broadcast("cancelled", completed, "Cancelled by user")
                with self._seq_lock:
                    self._active_sequences.pop(sequence_key, None)
                return {"success": False, "error": "Cancelled", "steps_completed": completed}

            step_type = step.get("type", "")

            if step_type == "announce":
                text = step.get("text", "")
                step_voice = step.get("voice", voice)
                _broadcast("in_progress", completed, f"Announcing: {text[:60]}")

                result = self.announce_text(text, step_voice, gateway_origin)
                if "error" in result:
                    _broadcast("failed", completed, error=result["error"])
                    with self._seq_lock:
                        self._active_sequences.pop(sequence_key, None)
                    return {"success": False, "error": result["error"],
                            "steps_completed": completed, "failed_step": i}
                completed += 1

            elif step_type == "delay":
                minutes = step.get("minutes", 0)
                seconds = step.get("seconds", 0)
                total_seconds = (minutes * 60) + seconds
                delay_label = f"{minutes} min" if minutes else f"{seconds}s"
                _broadcast("in_progress", completed,
                           f"Waiting {delay_label}",
                           delay_seconds=total_seconds,
                           delay_remaining=total_seconds)

                # Sleep in 1-second increments for cancellation responsiveness
                for elapsed in range(total_seconds):
                    if cancel_event.is_set():
                        _broadcast("cancelled", completed, "Cancelled by user")
                        with self._seq_lock:
                            self._active_sequences.pop(sequence_key, None)
                        return {"success": False, "error": "Cancelled",
                                "steps_completed": completed}
                    time.sleep(1)
                    remaining = total_seconds - elapsed - 1
                    if remaining > 0 and remaining % 10 == 0:
                        _broadcast("in_progress", completed,
                                   f"Waiting {delay_label} ({remaining}s remaining)",
                                   delay_seconds=total_seconds,
                                   delay_remaining=remaining)
                completed += 1

        _broadcast("completed", completed)
        with self._seq_lock:
            self._active_sequences.pop(sequence_key, None)

        return {"success": True, "steps_completed": completed, "steps_total": len(steps)}

    def cancel_sequence(self, sequence_key: str) -> dict:
        """Cancel a running sequence."""
        with self._seq_lock:
            cancel = self._active_sequences.get(sequence_key)
            if cancel:
                cancel.set()
                return {"success": True, "message": f"Cancelling {sequence_key}"}
        return {"success": False, "error": f"No active sequence: {sequence_key}"}

    def get_active_sequences(self) -> list:
        """Return list of currently running sequence keys."""
        with self._seq_lock:
            return list(self._active_sequences.keys())

    # ---- Upload MP3 ----

    def cache_uploaded_audio(self, audio_bytes: bytes, original_filename: str) -> dict:
        """Cache an uploaded MP3 file and return the gateway URL."""
        if not audio_bytes or len(audio_bytes) < 100:
            return {"error": "Invalid or empty audio file"}

        ext = os.path.splitext(original_filename)[1] or ".mp3"
        filename = hashlib.md5(
            (original_filename + str(time.time())).encode()
        ).hexdigest() + ext

        content_type = "audio/mpeg"
        if ext.lower() in (".wav",):
            content_type = "audio/wav"
        elif ext.lower() in (".ogg",):
            content_type = "audio/ogg"

        with self._cache_lock:
            now = time.time()
            expired = [k for k, v in self._cache.items() if now - v["created"] > self._CACHE_TTL]
            for k in expired:
                del self._cache[k]
            while len(self._cache) >= self._CACHE_MAX:
                oldest = min(self._cache, key=lambda k: self._cache[k]["created"])
                del self._cache[oldest]
            self._cache[filename] = {
                "bytes": audio_bytes,
                "created": now,
                "content_type": content_type,
            }

        url = f"/api/tts/audio/{filename}"
        self.logger.info("Audio uploaded: %s (%d bytes) -> %s",
                         original_filename, len(audio_bytes), url)
        return {"url": url, "size": len(audio_bytes), "filename": original_filename}

    # ---- Macro Integration ----

    def execute_macro_step(self, step: dict, gateway_origin: str = "",
                           tablet: str = "") -> dict:
        """Execute a tts_announce macro step. Supports preset, sequence, or inline text."""
        voice = step.get("voice")

        if step.get("preset"):
            return self.announce_preset(step["preset"], voice, gateway_origin)

        if step.get("sequence"):
            return self.run_sequence(step["sequence"], voice, gateway_origin, tablet)

        text = step.get("text", "")
        if text:
            return self.announce_text(text, voice, gateway_origin)

        return {"error": "tts_announce step requires 'preset', 'sequence', or 'text'"}

    # ---- Helpers ----

    def _get_ha_cfg(self) -> dict:
        if self.ctx:
            return self.ctx.cfg.get("home_assistant", {})
        return self.cfg.get("home_assistant", {})
