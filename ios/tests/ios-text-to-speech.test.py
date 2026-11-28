"""Voice-memo playback: RBSpeechProtocol forwards the RN TextToSpeech RPC to the Host.

The official client synthesizes `voice_memo` text messages itself through
/aiserver.v1.AiService/TextToSpeech ({ text, voiceId } -> { audio: base64, mimeType }).
RBSpeechProtocol already forwarded TranscribeAudio; it now also maps TextToSpeech to the Host's
/local/audio/speech with Accept: application/json, so the Host answers in the RPC JSON shape.
"""
import pathlib
import shutil
import subprocess
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'clients/ios/RBSpeech.m'


class TextToSpeechProtocolTest(unittest.TestCase):
    def setUp(self):
        self.source = SOURCE.read_text(encoding='utf-8')

    def test_intercepts_both_speech_rpcs(self):
        self.assertIn('@"/aiserver.v1.AiService/TextToSpeech"', self.source)
        self.assertIn('[request.URL.path isEqual:RBTranscribePath] || [request.URL.path isEqual:RBTextToSpeechPath]', self.source)

    def test_maps_to_host_speech_endpoint_with_json_reply(self):
        self.assertIn('speech ? @"/local/audio/speech" : @"/local/audio/transcriptions"', self.source)
        self.assertIn('@"Accept":@"application/json"', self.source)
        self.assertIn('[payload[@"text"] isKindOfClass:NSString.class]', self.source)
        self.assertIn('NSUInteger limit = speech ? 64 * 1024 : 36 * 1024 * 1024;', self.source)

    @unittest.skipUnless(shutil.which('xcrun'), 'Xcode is required')
    def test_compiles_for_ios(self):
        sdk = subprocess.run(['xcrun', '--sdk', 'iphoneos', '--show-sdk-path'], capture_output=True, text=True)
        if sdk.returncode != 0:
            self.skipTest('iPhoneOS SDK is not installed')
        subprocess.run(['xcrun', '--sdk', 'iphoneos', 'clang', '-arch', 'arm64', '-isysroot', sdk.stdout.strip(),
                        '-miphoneos-version-min=15.1', '-fobjc-arc', '-fblocks', '-Wall', '-Wextra', '-Werror',
                        '-Wno-unused-parameter', '-Wno-deprecated-declarations', '-Wno-nullability-completeness',
                        '-fsyntax-only', str(SOURCE)], check=True, cwd=SOURCE.parent)


if __name__ == '__main__':
    unittest.main()
