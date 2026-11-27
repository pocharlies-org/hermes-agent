"""Voice transcode arc (#97873): [[audio_as_voice]] works for every audio format.

Found by a maintainer-directed all-platform hint verification: the telegram
hint claimed '.ogg sends as voice bubbles' but bare MEDIA:.ogg (no directive)
ships as a document, and mp3+directive DEAD-ENDED into document delivery.
Fix: shared transcode_to_ogg_opus in base.py; telegram/feishu send_voice
transcode non-opus input; should_send_media_as_audio honors explicit
is_voice for any audio ext on telegram; is_voice threaded through the three
dispatch call sites.
"""
import asyncio
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from gateway.platforms.base import should_send_media_as_audio, transcode_to_ogg_opus


class TestVoiceRouting(unittest.TestCase):
    def test_telegram_explicit_voice_any_audio_ext(self):
        """[[audio_as_voice]] intent routes EVERY audio format to send_voice."""
        for ext in (".mp3", ".wav", ".flac", ".m4a", ".ogg", ".opus"):
            self.assertTrue(
                should_send_media_as_audio("telegram", ext, is_voice=True),
                f"{ext} with is_voice=True must route to the voice sender",
            )

    def test_telegram_without_intent_unchanged(self):
        """No directive: .mp3/.m4a -> sendAudio; .ogg NOT voice; .wav -> document."""
        self.assertTrue(should_send_media_as_audio("telegram", ".mp3", is_voice=False))
        self.assertTrue(should_send_media_as_audio("telegram", ".m4a", is_voice=False))
        self.assertFalse(should_send_media_as_audio("telegram", ".ogg", is_voice=False))
        self.assertFalse(should_send_media_as_audio("telegram", ".wav", is_voice=False))

    def test_other_platforms_unchanged(self):
        self.assertTrue(should_send_media_as_audio("feishu", ".mp3", is_voice=False))
        self.assertFalse(should_send_media_as_audio("feishu", ".qzx7", is_voice=False))


class TestTranscodeEngine(unittest.TestCase):
    def test_missing_ffmpeg_returns_none(self):
        with patch("shutil.which", return_value=None):
            self.assertIsNone(transcode_to_ogg_opus("/tmp/x.mp3"))

    def test_transcode_failure_cleans_up(self):
        """A failing ffmpeg leaves no orphan temp file behind."""
        import subprocess

        fake = subprocess.CompletedProcess(args=[], returncode=1, stdout=b"", stderr=b"boom")
        with patch("shutil.which", return_value="ffmpeg"), \
             patch("subprocess.run", return_value=fake):
            before = set(os.listdir(tempfile.gettempdir()))
            self.assertIsNone(transcode_to_ogg_opus("/tmp/x.mp3"))
            leaked = [f for f in os.listdir(tempfile.gettempdir())
                      if f.startswith("voice_transcode_") and f not in before]
            self.assertEqual(leaked, [])


class TestTelegramSendVoiceTranscode(unittest.TestCase):
    def test_mp3_with_intent_is_transcoded_and_sent_as_voice(self):
        """mp3 + is_voice=True: adapter transcodes, calls bot.send_voice, cleans up."""
        from plugins.platforms.telegram.adapter import TelegramAdapter

        adapter = TelegramAdapter.__new__(TelegramAdapter)

        sent = {}

        class _Msg:
            message_id = 42

        async def fake_retry(send_fn, kwargs_dict, *a, **kw):
            sent["fn"] = getattr(send_fn, "__name__", str(send_fn))
            sent["kwargs"] = kwargs_dict
            return _Msg()

        class _Bot:
            async def send_voice(self, **kw):  # identity only
                raise AssertionError("should go through retry helper")

        adapter._bot = _Bot()
        adapter._reply_to_mode = None
        # 'name' is a read-only property on the adapter; the send path only
        # uses it for log strings, so bypass via the instance dict shim.
        object.__setattr__(adapter, "_name", "telegram-test")
        adapter._send_with_dm_topic_reply_anchor_retry = fake_retry
        adapter._metadata_thread_id = lambda *_: None
        adapter._reply_to_message_id_for_send = lambda *a, **k: None
        adapter._thread_kwargs_for_send = lambda *a, **k: {}
        adapter._notification_kwargs = lambda *_: {}
        adapter._missing_media_path_error = lambda kind, p: f"missing {p}"

        fd, mp3 = tempfile.mkstemp(suffix=".mp3")
        os.write(fd, b"ID3fakebytes")
        os.close(fd)

        fd2, fake_ogg = tempfile.mkstemp(suffix=".ogg")
        os.write(fd2, b"OggSfakeopus")
        os.close(fd2)

        transcode_calls = []

        def fake_transcode(path, **kw):
            transcode_calls.append(path)
            return fake_ogg

        try:
            with patch("gateway.platforms.base.transcode_to_ogg_opus", side_effect=fake_transcode), \
                 patch("plugins.platforms.telegram.adapter._probe_voice_duration_seconds", return_value=1):
                result = asyncio.run(
                    adapter.send_voice("123", mp3, is_voice=True)
                )
            self.assertTrue(result.success, result.error)
            self.assertEqual(transcode_calls, [mp3])
            self.assertIn("voice", sent["kwargs"])  # routed to send_voice branch
            self.assertFalse(os.path.exists(fake_ogg), "transcoded temp must be cleaned up")
        finally:
            for p in (mp3, fake_ogg):
                try:
                    os.unlink(p)
                except OSError:
                    pass


class TestLiveAdapterVoiceForwarding(unittest.TestCase):
    def test_send_message_tool_forwards_is_voice_to_send_voice(self):
        """The fourth voice dispatch site: _send_live_adapter_media must pass is_voice to
        send_voice, or the telegram adapter skips the transcode and a .wav ships as a document."""
        from tools.send_message_tool import _send_live_adapter_media

        captured = {}

        class _Result:
            success = True
            message_id = "1"

        class _Adapter:
            async def send_voice(self, chat_id, audio_path, caption=None, reply_to=None,
                                 metadata=None, **kw):
                captured.update(kw)
                captured["method"] = "send_voice"
                return _Result()

        fd, wav = tempfile.mkstemp(suffix=".wav")
        os.write(fd, b"RIFFfake")
        os.close(fd)
        try:
            out = asyncio.run(_send_live_adapter_media(_Adapter(), "123", "", [(wav, True)]))
            self.assertNotIn("error", out, out)
            self.assertEqual(captured.get("method"), "send_voice")
            self.assertTrue(captured.get("is_voice"), "is_voice must reach send_voice for transcode")
        finally:
            os.unlink(wav)


class TestDirectBotVoiceTranscode(unittest.TestCase):
    def test_wav_with_intent_transcodes_and_sends_voice(self):
        """Direct-bot path (no live adapter): .wav + is_voice=True must transcode and go to
        send_voice, not send_document (DGX-1928, the sender _send_live_adapter_media's twin)."""
        from tools.send_message_senders import _telegram_send_one_media

        sent = {}

        class _Msg:
            message_id = 7

        class _Bot:
            async def send_voice(self, **kw):
                sent["kind"] = "voice"
                return _Msg()

            async def send_document(self, **kw):
                sent["kind"] = "document"
                return _Msg()

        fd, wav = tempfile.mkstemp(suffix=".wav")
        os.write(fd, b"RIFFfake")
        os.close(fd)
        fd2, ogg = tempfile.mkstemp(suffix=".ogg")
        os.write(fd2, b"OggSfake")
        os.close(fd2)
        try:
            with patch("gateway.platforms.base.transcode_to_ogg_opus", return_value=ogg), \
                 patch("plugins.platforms.telegram.adapter._probe_voice_duration_seconds", return_value=1):
                asyncio.run(_telegram_send_one_media(
                    _Bot(), "1", wav, True, caption=None, parse_mode=None, has_html=False,
                    thread_kwargs={}, force_document=False))
            self.assertEqual(sent.get("kind"), "voice")
            self.assertFalse(os.path.exists(ogg), "transcoded temp must be cleaned up")
        finally:
            for p in (wav, ogg):
                try:
                    os.unlink(p)
                except OSError:
                    pass


if __name__ == "__main__":
    unittest.main()
