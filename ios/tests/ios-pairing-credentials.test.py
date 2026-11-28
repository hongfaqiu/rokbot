#!/usr/bin/env python3
"""Regression checks for credentials written by the iOS pairing flow and rebrand link blocking."""

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
import unittest


IOS_ROOT = Path(__file__).resolve().parents[1]
SOURCE = (IOS_ROOT / "clients" / "ios" / "RBConnection.m").read_text(encoding="utf-8")

DEEPLINK_HARNESS = r"""
#import <Foundation/Foundation.h>
#include <stdio.h>
#include <stdlib.h>

#import "RBDeepLinks.m"

@interface RBConnection ()
@property(nonatomic, readwrite) NSString *serverURL;
@property(nonatomic, readwrite) NSString *deviceToken;
@end

@implementation RBConnection
+ (instancetype)shared {
  static RBConnection *instance;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ instance = [self new]; });
  return instance;
}
- (BOOL)restore:(NSError **)error { return NO; }
- (void)show {}
- (void)disconnect {}
@end

void RBDiagnosticsEvent(NSString *event, NSDictionary *values) {
  (void)event; (void)values;
}

// RBCanvas.m stand-in: in-app canvas links open the canvas view instead of the browser.
static NSURL *RBCanvasOpened;
BOOL RBOpenCanvasURL(NSURL *url) {
  if (![url.path hasPrefix:@"/canvas/app/"]) return NO;
  RBCanvasOpened = url;
  return YES;
}

void RBSuggestionsNoteOpenedAgent(NSString *agentId) {
  (void)agentId;
}

#define CHECK(expr) do { if (!(expr)) { fprintf(stderr, "FAIL line %d: %s\n", __LINE__, #expr); exit(1); } } while (0)

int main(void) { @autoreleasepool {
  RBConnection.shared.serverURL = @"http://host.example.local:18080";

  // Blocked external Grok Bot / vendor / store / feedback links
  CHECK(RBShouldBlockExternalURL([NSURL URLWithString:@"https://grok.com/help"]));
  CHECK(RBShouldBlockExternalURL([NSURL URLWithString:@"https://sub.x.ai/docs"]));
  CHECK(RBShouldBlockExternalURL([NSURL URLWithString:@"https://cursor.com/pricing"]));
  CHECK(RBShouldBlockExternalURL([NSURL URLWithString:@"mailto:feedback@x.ai?subject=bug"]));
  CHECK(RBShouldBlockExternalURL([NSURL URLWithString:@"itms-apps://apps.apple.com/app/id1"]));

  // Allowed Host / loopback / OTA / system / non-vendor links
  CHECK(!RBShouldBlockExternalURL([NSURL URLWithString:@"https://127.0.0.1:18080/local/updates/ios.ipa"]));
  CHECK(!RBShouldBlockExternalURL([NSURL URLWithString:@"http://host.example.local:18080/web/"]));
  CHECK(!RBShouldBlockExternalURL([NSURL URLWithString:@"itms-services://?action=download-manifest&url=https://h.example/m.plist"]));
  CHECK(!RBShouldBlockExternalURL([NSURL URLWithString:@"app-settings:"]));
  CHECK(!RBShouldBlockExternalURL([NSURL URLWithString:@"https://example.com/article"]));

  // Local scheme normalization
  CHECK([RBNormalizeLocalURL([NSURL URLWithString:@"rblocal://app/v1/chat?id=abc"]).absoluteString
      isEqualToString:@"grokbot://app/v1/chat?id=abc"]);
  CHECK([RBNormalizeLocalURL([NSURL URLWithString:@"rokbot-local://agent/bot_1"]).absoluteString
      isEqualToString:@"grokbot://app/v1/chat?id=bot_1"]);

  // A canvas link handed to RN Linking opens the canvas view and resolves YES without the original.
  __block id resolved = nil;
  RBRCTOpenURL(nil, NULL, [NSURL URLWithString:@"http://host.example.local:18080/canvas/app/044e3b41-0828-4466-9f6d-325569f828c6"],
               ^(id value) { resolved = value; }, nil);
  CHECK([resolved isEqual:@YES]);
  CHECK([RBCanvasOpened.path hasSuffix:@"044e3b41-0828-4466-9f6d-325569f828c6"]);

  puts("PASS: RBDeepLinks external URL blocking and scheme normalization");
  return 0;
} }
"""


class PairingCredentialsTests(unittest.TestCase):
    def test_pairing_syncs_app_intent_credentials_after_saving_token(self):
        marker = "RBConnection.shared.deviceToken = token;"
        source = SOURCE[SOURCE.index(marker) :]
        sync = source.index("RBSyncAppIntentCredentials();")
        # finishPairing: dismisses the sheet or tears down the required-pairing window.
        dismiss = source.index("[strong finishPairing:^{", sync)
        self.assertLess(sync, dismiss)

    def test_both_restore_and_connection_edit_keep_the_sync(self):
        self.assertGreaterEqual(SOURCE.count("RBSyncAppIntentCredentials();"), 4)

    def test_disconnect_synchronizes_defaults_and_clears_paired_bundle_dir(self):
        self.assertIn("standardUserDefaults synchronize", SOURCE)
        self.assertIn('URLByAppendingPathComponent:@"RokBotPaired"', SOURCE)

    def test_bootstrap_intercepts_signout_and_login_screen_host_entry(self):
        bootstrap = (
            Path(__file__).resolve().parents[1] / "clients" / "ios" / "RBBootstrap.m"
        ).read_text(encoding="utf-8")
        app_intents = (
            Path(__file__).resolve().parents[1] / "clients" / "ios" / "RBAppIntents.m"
        ).read_text(encoding="utf-8")
        self.assertIn("RBSignOutLabels", bootstrap)
        self.assertIn("RBIsSettingsSignOutContext", bootstrap)
        self.assertNotIn('@"Account", @"账户", @"帳戶"', bootstrap)
        self.assertIn("RBClearHostSettingsIdentifier", bootstrap)
        self.assertIn("RBHasAncestorPluginTag", bootstrap)
        self.assertIn("RBSubtreeHasStyledHostButton", bootstrap)
        self.assertIn("confirmSignOut", bootstrap)
        self.assertIn("[RBConnection.shared disconnect]", bootstrap)
        self.assertIn("RBPrimaryLoginLabels", bootstrap)
        self.assertIn("RBSecondaryLoginLabels", bootstrap)
        self.assertIn("isFabricView && !paired && [primaryLogin containsObject:label]", bootstrap)
        self.assertIn("isFabricView && !paired && [secondaryLogin containsObject:label]", bootstrap)
        self.assertIn('NSClassFromString(@"RCTViewComponentView")', bootstrap)
        self.assertIn('@"Sign in with Apple"', bootstrap)
        self.assertIn('@"退出登录"', bootstrap)
        self.assertIn('RBDeleteAppIntentCredential(@"x.money.agent-connection-code:no-auth",\n                                  @"grok-bot", defaultGroup);', app_intents)
        self.assertIn('RBDeleteAppIntentCredential(@"app:no-auth",\n                                  @"sand.cursor-tokens", nil);', app_intents)
        self.assertIn("RBGlobalSettingsContextState", bootstrap)
        self.assertIn("RBSettingsContextUnknown", bootstrap)
        self.assertIn("RBInvalidateSettingsContextCache", bootstrap)
        self.assertIn("RBNoteSettingsMarkerOnView", bootstrap)
        self.assertIn("RBVerifyAppIntentCredentialsAsync", bootstrap)
        self.assertNotIn("if (matched || epoch == RBSettingsContextEpoch)", bootstrap)
        push = (
            Path(__file__).resolve().parents[1] / "clients" / "ios" / "RBPush.m"
        ).read_text(encoding="utf-8")
        self.assertIn("RBSettingsContextState settingsState = RBGlobalSettingsContextState(view);", push)
        self.assertIn("settingsState == RBSettingsContextNo", push)
        library = (
            Path(__file__).resolve().parents[1] / "clients" / "ios" / "RBLibrary.m"
        ).read_text(encoding="utf-8")
        self.assertIn('[path hasPrefix:@"/api/"]', library)
        self.assertIn('[path.lastPathComponent isEqualToString:@"openAgentWindowed"]', library)
        connectors = (
            Path(__file__).resolve().parents[1] / "clients" / "ios" / "RBConnectors.m"
        ).read_text(encoding="utf-8")
        diagnostics = (
            Path(__file__).resolve().parents[1] / "clients" / "ios" / "RBDiagnostics.m"
        ).read_text(encoding="utf-8")
        self.assertNotIn("RBInstallSessionConfigurationProvider", connectors)
        self.assertIn("sessionWithConfiguration:delegate:delegateQueue:", connectors)
        self.assertIn("config.identifier.length", connectors)
        self.assertIn("RBResolveReactSymbol", diagnostics)
        self.assertIn('@"RCTFatalException"', diagnostics)
        deep_links = (
            Path(__file__).resolve().parents[1] / "clients" / "ios" / "RBDeepLinks.m"
        ).read_text(encoding="utf-8")
        self.assertIn("RBShouldBlockExternalURL", deep_links)
        self.assertIn("openURL:options:completionHandler:", deep_links)
        self.assertIn('@"grok.com"', deep_links)

    def test_deep_links_external_url_blocking_native(self):
        if sys.platform != 'darwin' or not shutil.which('clang'):
            self.skipTest('macOS clang is required')
        runtime = IOS_ROOT / '.runtime'
        runtime.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='deeplinks-tests-', suffix='.noindex', dir=runtime) as temp:
            work = Path(temp)
            (work / 'UIKit').mkdir()
            (work / 'UIKit' / 'UIKit.h').write_text('#import <Foundation/Foundation.h>\n@class UIView;\n@class UIViewController;\n', encoding='utf-8')
            harness = work / 'test.m'
            harness.write_text(DEEPLINK_HARNESS, encoding='utf-8')
            binary = work / 'test-bin'
            subprocess.run(
                [
                    'clang', '-fobjc-arc', '-fblocks', '-Wall', '-Wextra', '-Werror',
                    '-Wno-unused-parameter', '-Wno-deprecated-declarations', '-Wno-nullability-completeness',
                    '-I', str(work), '-I', str(IOS_ROOT / 'clients' / 'ios'),
                    '-framework', 'Foundation',
                    str(harness), '-o', str(binary),
                ],
                check=True,
                cwd=IOS_ROOT / 'tests',
            )
            subprocess.run([str(binary)], check=True, timeout=15)


if __name__ == "__main__":
    unittest.main()
