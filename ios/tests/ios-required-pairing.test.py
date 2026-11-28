"""Forced required-pairing page contract (RBConnection.m / RBBootstrap.m)."""
from pathlib import Path
import re
import unittest

IOS_ROOT = Path(__file__).resolve().parents[1]
CLIENT = IOS_ROOT / 'clients' / 'ios'


def function_body(source, signature):
    # Skip declarations (`...;`): use the first occurrence whose `{` precedes any `;`.
    start = source.index(signature)
    while True:
        brace = source.index('{', start)
        semicolon = source.find(';', start)
        if semicolon == -1 or brace < semicolon:
            break
        start = source.index(signature, start + 1)
    depth = 0
    for index in range(brace, len(source)):
        if source[index] == '{':
            depth += 1
        elif source[index] == '}':
            depth -= 1
            if depth == 0:
                return source[brace:index + 1]
    raise AssertionError(f'unterminated {signature}')


class RequiredPairing(unittest.TestCase):
    def setUp(self):
        self.connection = (CLIENT / 'RBConnection.m').read_text(encoding='utf-8')
        self.header = (CLIENT / 'RBConnection.h').read_text(encoding='utf-8')
        self.bootstrap = (CLIENT / 'RBBootstrap.m').read_text(encoding='utf-8')

    def test_exported_entry_points(self):
        for name in ('BOOL RBShowRequiredPairing(void);', 'BOOL RBRequiredPairingVisible(void);',
                     'void RBDismissRequiredPairing(void);'):
            self.assertIn('FOUNDATION_EXPORT ' + name, self.header)

    def test_full_screen_window_above_app_window_and_not_dismissible(self):
        body = function_body(self.connection, 'BOOL RBShowRequiredPairing(void)')
        self.assertIn('[[UIWindow alloc] initWithWindowScene:scene]', body)
        self.assertIn('window.windowLevel = appWindow.windowLevel + 1;', body)
        self.assertIn('if (!scene || !appWindow) return NO;', body)
        self.assertIn('nav.modalPresentationStyle = UIModalPresentationFullScreen;', body)
        self.assertIn('nav.modalInPresentation = YES;', body)
        self.assertIn('vc.required = YES;', body)
        self.assertIn('window.rootViewController = nav;', body)
        self.assertIn('[window makeKeyAndVisible];', body)
        # Already paired: never show, and tear down a stale window.
        self.assertLess(body.index('connection.isPaired'), body.index('initWithWindowScene'))
        self.assertIn('RBDismissRequiredPairing();', body.split('initWithWindowScene')[0])

    def test_close_control_hidden_and_close_is_a_no_op(self):
        render = function_body(self.connection, '- (void)renderConnection')
        self.assertIn('self.navigationItem.rightBarButtonItem = self.required ? nil :', render)
        self.assertIn('self.navigationItem.hidesBackButton = self.required;', render)
        close = function_body(self.connection, '- (void)close')
        self.assertTrue(close.lstrip('{').lstrip().startswith('if (self.required) return;'))

    def test_successful_pairing_tears_down_required_window(self):
        finish = function_body(self.connection, '- (void)finishPairing:(void (^)(void))completion')
        self.assertIn('RBDismissRequiredPairing();', finish)
        self.assertIn('completion()', finish)
        pair = function_body(self.connection, '- (void)pair')
        update = function_body(self.connection, '- (void)updateConnection:(NSString *)base')
        for body in (pair, update):
            self.assertIn('[strong finishPairing:^{', body)
            self.assertNotIn('dismissViewControllerAnimated', body)
        dismiss = function_body(self.connection, 'void RBDismissRequiredPairing(void)')
        self.assertIn('window.hidden = YES;', dismiss)
        self.assertIn('makeKeyWindow', dismiss)

    def test_manual_show_while_unpaired_uses_required_page(self):
        show = function_body(self.connection, '- (void)show')
        self.assertTrue(show.lstrip('{').lstrip().startswith('if (!self.isPaired && RBShowRequiredPairing()) return;'))

    def test_retry_every_quarter_second_up_to_twenty_attempts(self):
        self.assertIn('static const NSInteger RBRequiredPairingMaxAttempts = 20;', self.bootstrap)
        self.assertIn('static const int64_t RBRequiredPairingRetryNanoseconds = NSEC_PER_SEC / 4;', self.bootstrap)
        attempt = function_body(self.bootstrap, 'static void RBPresentRequiredPairingAttempt(')
        self.assertIn('if (generation != RBRequiredPairingGeneration) return;', attempt)
        self.assertIn('if (RBShowRequiredPairing()) return;', attempt)
        self.assertIn('attempt + 1 >= RBRequiredPairingMaxAttempts', attempt)
        self.assertIn('RBRequiredPairingRetryNanoseconds', attempt)

    def test_triggers_launch_did_become_active_and_content_did_appear(self):
        init = function_body(self.bootstrap, '__attribute__((constructor)) static void RBInitialize(void)')
        active = init.split('UIApplicationDidBecomeActiveNotification', 1)[1].split('}];', 1)[0]
        self.assertIn('RBPresentRequiredPairing();', active)
        self.assertRegex(init, re.compile(
            r'addObserverForName:@"RCTContentDidAppearNotification".*?RBPresentRequiredPairing\(\);', re.S))
        launch = init.split('dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), dispatch_get_main_queue(), ^{\n        if (restored', 1)[1]
        self.assertIn('RBPresentRequiredPairing();', launch.split('if (!RBStartupRefreshed)', 1)[0])

    def test_no_presented_modal_fallback_and_disconnect_returns_to_window(self):
        # The 922073d presentViewController: required-pairing modal was replaced
        # by the separate window; it must not coexist.
        show = function_body(self.connection, 'BOOL RBShowRequiredPairing(void)')
        self.assertNotIn('presentViewController', show)
        self.assertNotIn('connection.pairing.required', self.connection)
        self.assertNotIn('lockedToPairing', self.connection)
        self.assertNotIn('static void RBPresentRequiredPairing(NSUInteger attempt)', self.bootstrap)
        self.assertNotIn('RBPresentRequiredPairing(0)', self.bootstrap)
        self.assertEqual(self.bootstrap.count('static void RBPresentRequiredPairing('), 1)
        finish = function_body(self.connection, '- (void)finishDisconnect')
        self.assertIn('RBShowRequiredPairing()', finish)
        self.assertNotIn('controller.required = YES', finish)
        self.assertNotIn('renderConnection', finish)


if __name__ == '__main__':
    unittest.main()
