"""Bot avatar page > Generate: RBSpeechProtocol forwards RunGenerateImage to the Host.

The official RN client calls /aiserver.v1.AiService/RunGenerateImage with
{ description: <full avatar prompt>, modelId, maxMode, aspectRatio } and reads
{ success: { imageData } } or { error: { error } } (same AvatarGeneration code as Android; checked
in a local iOS main.jsbundle). RBSpeechProtocol now maps it to the Host's /local/avatar/generate
with Accept: application/json, keeping only description and aspectRatio.
"""
import pathlib
import shutil
import subprocess
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'clients/ios/RBSpeech.m'


class AvatarGenerateProtocolTest(unittest.TestCase):
    def setUp(self):
        self.source = SOURCE.read_text(encoding='utf-8')

    def test_intercepts_run_generate_image(self):
        self.assertIn('static NSString *const RBAvatarImagePath = @"/aiserver.v1.AiService/RunGenerateImage";', self.source)
        self.assertIn('[request.URL.path isEqual:RBAvatarImagePath]', self.source)

    def test_maps_to_host_avatar_endpoint_with_json_reply(self):
        self.assertIn('avatar ? @"/local/avatar/generate" : speech ? @"/local/audio/speech" : @"/local/audio/transcriptions"', self.source)
        self.assertIn('if (avatar) limit = 128 * 1024;', self.source)
        self.assertIn('[payload[@"description"] isKindOfClass:NSString.class]', self.source)
        # Generation can take minutes; the Host gives up at 180 s.
        self.assertIn('request.timeoutInterval = avatar ? 200 : 125;', self.source)
        self.assertIn('@"Accept":@"application/json"', self.source)

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
