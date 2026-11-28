#!/usr/bin/env python3
"""Regression checks for iOS disconnect device self-revoke and Scan Document localization."""

from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import unittest


IOS_ROOT = Path(__file__).resolve().parents[1]

OBJC_HARNESS = r"""
#import <Foundation/Foundation.h>
#include <stdio.h>
#include <stdlib.h>

// Minimal UIKit/RB stubs so RBConnection.m compiles and runs natively on macOS.
#import <UIKit/UIKit.h>
#import <Security/Security.h>
#import "RBHermes.h"

static int gNetworkCleared = 0;
static int gReloadCount = 0;
static int gSyncIntentsCount = 0;
static NSMutableArray<NSDictionary *> *gDiagEvents = nil;

void RBNetworkClear(void) { gNetworkCleared++; }
NSString *RBNetworkRestore(NSString *saved) { return saved; }
NSString *RBNetworkAddress(void) { return @""; }
BOOL RBNetworkEnabled(void) { return NO; }
NSDictionary *RBNetworkStatus(void) { return @{}; }
NSString *RBNetworkPrepare(NSString *address, BOOL tailcat, NSError **error) { return address; }
BOOL RBNetworkCommit(void) { return YES; }
void RBNetworkRollback(void) {}
void RBClearProfileCache(void) {}
void RBRestoreProfileCache(void) {}
NSString *RBProfileHostName(void) { return @"Host"; }
NSString *RBProfileName(void) { return @"User"; }
id RBProfileAvatar(void) { return nil; }
void RBClearModelOnboardingState(void) {}
void RBShowModelsFrom(id vc) {}
void RBShowAvatarStyleFrom(id vc) {}
void RBShowUpdaterFrom(id vc) {}
void RBPresentNetworkScanner(id vc, void (^cb)(NSString *)) {}
NSString *RBClientDeviceId(void) { return @"test-client-id"; }
void RBSyncAppIntentCredentials(void) { gSyncIntentsCount++; }
void RBReloadReactHost(void) { gReloadCount++; }
void RBDiagnosticsEvent(NSString *event, NSDictionary *values) {
  [gDiagEvents addObject:@{@"event": event ?: @"", @"values": values ?: @{}}];
}
NSString *RBL(NSString *zh, NSString *en) { return en; }
NSURLSession *RBHTTPSession(void) {
  static NSURLSession *session;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    session = [NSURLSession sessionWithConfiguration:NSURLSessionConfiguration.ephemeralSessionConfiguration];
  });
  return session;
}

@implementation RBHermes
+ (NSData *)gatewayData:(NSString *)url token:(NSString *)token resources:(NSURL *)resources error:(NSError **)error { return nil; }
+ (NSURL *)writeGateway:(NSString *)url token:(NSString *)token resources:(NSURL *)resources error:(NSError **)error { return nil; }
@end

#define SecItemDelete(q) (errSecSuccess)
#define SecItemCopyMatching(q, r) (errSecItemNotFound)
#define SecItemUpdate(q, a) (errSecSuccess)
#define SecItemAdd(q, r) (errSecSuccess)
#import "RBConnection.m"

// Settings entry points that newer RBConnection.m links against.
void RBShowSuggestionsSettingsFrom(UIViewController *presenter) {}
void RBSuggestionsInvalidate(void) {}
void RBShowCreateGroupFrom(UIViewController *presenter) {}
void RBShowMigrateFrom(UIViewController *presenter) {}
@implementation RBSegmentControl
- (instancetype)initWithItems:(NSArray<NSString *> *)items { return [super initWithFrame:(CGRect){{0, 0}, {0, 0}}]; }
- (NSUInteger)numberOfSegments { return 2; }
@end


#define CHECK(expr) do { if (!(expr)) { fprintf(stderr, "FAIL line %d: %s\n", __LINE__, #expr); exit(1); } } while (0)

static BOOL waitUntil(BOOL (^pred)(void), NSTimeInterval timeout) {
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:timeout];
  while (!pred() && [deadline timeIntervalSinceNow] > 0) {
    [NSRunLoop.mainRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.02]];
  }
  return pred();
}

int main(int argc, char **argv) { @autoreleasepool {
  CHECK(argc == 3);
  NSString *okURL = [NSString stringWithUTF8String:argv[1]];
  NSString *deadURL = [NSString stringWithUTF8String:argv[2]];
  gDiagEvents = [NSMutableArray new];

  // Case 1: Reachable host returns 200 -> revokes on server and clears local state.
  __block BOOL done1 = NO;
  RBConnection *conn = RBConnection.shared;
  conn.serverURL = okURL;
  conn.deviceToken = @"tok-live-123";
  CHECK(conn.isPaired);
  conn.didDisconnect = ^{ done1 = YES; };
  [conn disconnect];
  CHECK(waitUntil(^BOOL{ return done1; }, 5.0));
  CHECK(!conn.isPaired);
  CHECK(conn.serverURL == nil);
  CHECK(conn.deviceToken == nil);
  CHECK(gNetworkCleared == 1);
  CHECK(gSyncIntentsCount >= 1);

  // Case 2: Unreachable host fails fast -> still clears local state without hanging.
  __block BOOL done2 = NO;
  conn.serverURL = deadURL;
  conn.deviceToken = @"tok-dead-456";
  CHECK(conn.isPaired);
  conn.didDisconnect = ^{ done2 = YES; };
  [conn disconnect];
  CHECK(waitUntil(^BOOL{ return done2; }, 5.0));
  CHECK(!conn.isPaired);
  CHECK(conn.serverURL == nil);
  CHECK(conn.deviceToken == nil);
  CHECK(gNetworkCleared == 2);

  // No scene/app window here: the required-pairing window cannot appear yet and
  // the removed presentViewController: modal path must not be used instead.
  for (NSDictionary *e in gDiagEvents) CHECK(![e[@"event"] isEqualToString:@"connection.pairing.required"]);

  puts("PASS: iOS disconnect self-revoke and offline cleanup");
  return 0;
} }
"""


class DisconnectRevokeTests(unittest.TestCase):
    def test_source_calls_self_revoke_with_timeout_and_localizes_scan_document(self):
        conn = (IOS_ROOT / "clients" / "ios" / "RBConnection.m").read_text(encoding="utf-8")
        self.assertIn('/local/device/revoke', conn)
        self.assertIn('request.timeoutInterval = 5.0;', conn)
        self.assertIn('finishDisconnect', conn)
        self.assertNotIn('/admin/api/devices/', conn)

        bootstrap = (IOS_ROOT / "clients" / "ios" / "RBBootstrap.m").read_text(encoding="utf-8")
        self.assertIn('RBActionWithTitle', bootstrap)
        self.assertIn('@"Scan Document"', bootstrap)
        self.assertIn('@"扫描文稿"', bootstrap)

    def test_native_disconnect_calls_revoke_and_falls_back_on_error(self):
        if sys.platform != "darwin" or not shutil.which("clang"):
            self.skipTest("macOS clang is required")

        received = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                body = self.rfile.read(length) if length else b""
                received.append((self.path, self.headers.get("Authorization"), body))
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"ok":true}')

            def log_message(self, *args):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        # Find an unused port that refuses connections immediately.
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.bind(("127.0.0.1", 0))
        dead_port = sock.getsockname()[1]
        sock.close()

        try:
            runtime = IOS_ROOT / ".runtime"
            runtime.mkdir(exist_ok=True)
            with tempfile.TemporaryDirectory(prefix="disconnect-tests-", suffix=".noindex", dir=runtime) as temp:
                work = Path(temp)
                # Verify against macOS Foundation using minimal UIKit shim
                (work / "UIKit").mkdir()
                (work / "UIKit" / "UIKit.h").write_text(
                    """
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
typedef NS_ENUM(NSInteger, UIModalPresentationStyle) { UIModalPresentationPageSheet, UIModalPresentationFullScreen };
typedef NS_ENUM(NSInteger, UILayoutConstraintAxis) { UILayoutConstraintAxisHorizontal, UILayoutConstraintAxisVertical };
typedef NS_ENUM(NSInteger, UIStackViewAlignment) { UIStackViewAlignmentCenter };
typedef NS_ENUM(NSInteger, NSTextAlignment) { NSTextAlignmentCenter };
typedef NS_ENUM(NSInteger, UITextBorderStyle) { UITextBorderStyleNone };
typedef NS_ENUM(NSInteger, UITextFieldViewMode) { UITextFieldViewModeAlways, UITextFieldViewModeWhileEditing };
typedef NS_ENUM(NSInteger, UITextAutocapitalizationType) { UITextAutocapitalizationTypeNone, UITextAutocapitalizationTypeAllCharacters };
typedef NS_ENUM(NSInteger, UITextAutocorrectionType) { UITextAutocorrectionTypeNo };
typedef NS_ENUM(NSInteger, UIKeyboardType) { UIKeyboardTypeURL };
typedef NS_ENUM(NSInteger, UIViewContentMode) { UIViewContentModeScaleAspectFit, UIViewContentModeScaleAspectFill };
typedef NS_ENUM(NSInteger, UIButtonType) { UIButtonTypeSystem };
typedef NS_ENUM(NSInteger, UIButtonConfigurationCornerStyle) { UIButtonConfigurationCornerStyleCapsule };
typedef NS_ENUM(NSInteger, UIControlEvents) { UIControlEventTouchUpInside = 1, UIControlEventValueChanged = 2 };
typedef NS_ENUM(NSInteger, UIControlState) { UIControlStateNormal = 0 };
typedef NS_ENUM(NSInteger, UIBarButtonSystemItem) { UIBarButtonSystemItemClose };
typedef NS_ENUM(NSInteger, UISceneActivationState) { UISceneActivationStateUnattached = -1, UISceneActivationStateForegroundActive, UISceneActivationStateForegroundInactive, UISceneActivationStateBackground };
typedef CGFloat UIWindowLevel;
typedef double UIFontWeight;
static const UIFontWeight UIFontWeightBold = 0, UIFontWeightRegular = 0, UIFontWeightSemibold = 0, UIFontWeightMedium = 0;
static NSString *const UIFontTextStyleBody = @"body";
static NSString *const UITextContentTypeOneTimeCode = @"otp";
static NSString *const UITextContentTypePassword = @"pw";
@class UINavigationController;
@interface NSLayoutConstraint : NSObject @property BOOL active; + (void)activateConstraints:(NSArray *)c; @end
@interface NSLayoutAnchor : NSObject - (NSLayoutConstraint *)constraintEqualToAnchor:(id)a; - (NSLayoutConstraint *)constraintEqualToAnchor:(id)a constant:(CGFloat)c; - (NSLayoutConstraint *)constraintEqualToConstant:(CGFloat)c; - (NSLayoutConstraint *)constraintGreaterThanOrEqualToConstant:(CGFloat)c; @end
@interface UILayoutGuide : NSObject @property(readonly) NSLayoutAnchor *leadingAnchor,*trailingAnchor,*topAnchor,*bottomAnchor,*widthAnchor; @end
@interface CALayer : NSObject @property CGFloat cornerRadius; @end
@interface UIColor : NSObject + (UIColor *)labelColor; + (UIColor *)secondaryLabelColor; + (UIColor *)systemGroupedBackgroundColor; + (UIColor *)secondarySystemGroupedBackgroundColor; + (UIColor *)systemBackgroundColor; + (UIColor *)systemRedColor; @end
@interface UIFont : NSObject + (UIFont *)preferredFontForTextStyle:(NSString *)s; + (UIFont *)systemFontOfSize:(CGFloat)s weight:(UIFontWeight)w; + (UIFont *)monospacedSystemFontOfSize:(CGFloat)s weight:(UIFontWeight)w; @end
@interface UIImage : NSObject + (UIImage *)systemImageNamed:(NSString *)n; @end
@interface UIView : NSObject @property BOOL translatesAutoresizingMaskIntoConstraints, hidden, clipsToBounds; @property(strong) UIColor *backgroundColor,*tintColor; @property(readonly) CALayer *layer; @property(readonly) NSArray<UIView *> *subviews; @property(readonly) UILayoutGuide *safeAreaLayoutGuide; @property(readonly) NSLayoutAnchor *leadingAnchor,*trailingAnchor,*topAnchor,*bottomAnchor,*heightAnchor,*widthAnchor; @property(copy) NSString *accessibilityIdentifier,*accessibilityLabel; @property(strong) id window; - (void)addSubview:(UIView *)v; - (void)removeFromSuperview; - (BOOL)becomeFirstResponder; - (instancetype)initWithFrame:(CGRect)f; @end
@interface UIScrollView : UIView @property(readonly) UILayoutGuide *contentLayoutGuide,*frameLayoutGuide; @end
@interface UIStackView : UIView @property UILayoutConstraintAxis axis; @property UIStackViewAlignment alignment; @property CGFloat spacing; - (instancetype)initWithArrangedSubviews:(NSArray *)a; - (void)addArrangedSubview:(UIView *)v; - (void)setCustomSpacing:(CGFloat)s afterView:(UIView *)v; @end
@interface UILabel : UIView @property(copy) NSString *text; @property(strong) UIFont *font; @property(strong) UIColor *textColor; @property NSInteger numberOfLines; @property NSTextAlignment textAlignment; @end
@interface UIImageView : UIView @property UIViewContentMode contentMode; - (instancetype)initWithImage:(UIImage *)i; @end
@interface UIControl : UIView @property BOOL enabled; - (void)addTarget:(id)t action:(SEL)a forControlEvents:(UIControlEvents)e; @end
@interface UITextField : UIControl @property(copy) NSString *placeholder,*text,*textContentType; @property BOOL secureTextEntry; @property UITextBorderStyle borderStyle; @property(strong) UIView *leftView; @property UITextFieldViewMode leftViewMode, clearButtonMode; @property(strong) UIColor *textColor; @property UITextAutocapitalizationType autocapitalizationType; @property UITextAutocorrectionType autocorrectionType; @property UIKeyboardType keyboardType; @property(strong) UIFont *font; @end
@interface UISwitch : UIControl @property BOOL on; @end
@interface UISegmentedControl : UIControl @property NSInteger selectedSegmentIndex; - (instancetype)initWithItems:(NSArray *)i; @end
@interface UIButtonConfiguration : NSObject @property(copy) NSString *title; @property UIButtonConfigurationCornerStyle cornerStyle; @property(strong) UIColor *baseForegroundColor,*baseBackgroundColor; + (instancetype)tintedButtonConfiguration; + (instancetype)filledButtonConfiguration; @end
@interface UIButton : UIControl @property(strong) UIButtonConfiguration *configuration; + (instancetype)buttonWithType:(UIButtonType)t; - (void)setImage:(UIImage *)i forState:(UIControlState)s; @end
@interface UIBarButtonItem : NSObject - (instancetype)initWithBarButtonSystemItem:(UIBarButtonSystemItem)s target:(id)t action:(SEL)a; @end
@interface UINavigationItem : NSObject @property(strong) UIBarButtonItem *rightBarButtonItem; @property BOOL hidesBackButton; @end
@interface UINavigationBar : UIView @end
@interface UISheetPresentationControllerDetent : NSObject + (id)largeDetent; @end
@interface UISheetPresentationController : NSObject @property(copy) NSArray *detents; @property BOOL prefersGrabberVisible; @end
@interface UIViewController : NSObject @property(strong) UIView *view; @property(copy) NSString *title; @property(strong) UINavigationItem *navigationItem; @property(strong) UINavigationController *navigationController; @property(strong) UIViewController *presentedViewController; @property(strong) UIViewController *presentingViewController; @property UIModalPresentationStyle modalPresentationStyle; @property BOOL modalInPresentation; @property(readonly) BOOL isBeingPresented, isBeingDismissed; @property(readonly) UISheetPresentationController *sheetPresentationController; - (void)viewDidLoad; - (void)viewWillAppear:(BOOL)a; - (void)viewWillDisappear:(BOOL)a; - (void)presentViewController:(UIViewController *)vc animated:(BOOL)a completion:(void(^)(void))c; - (void)dismissViewControllerAnimated:(BOOL)a completion:(void(^)(void))c; @end
@interface UINavigationController : UIViewController @property(strong) UINavigationBar *navigationBar; - (instancetype)initWithRootViewController:(UIViewController *)vc; @end
@class UIWindowScene;
@interface UIWindow : UIView @property BOOL isKeyWindow; @property UIWindowLevel windowLevel; @property(strong) UIViewController *rootViewController; - (instancetype)initWithWindowScene:(UIWindowScene *)s; - (void)makeKeyWindow; - (void)makeKeyAndVisible; @end
@interface UIScene : NSObject @property(readonly) UISceneActivationState activationState; @end
@interface UIWindowScene : UIScene @property(readonly) NSArray<UIWindow *> *windows; @end
@interface UIApplication : NSObject @property(class, readonly) UIApplication *sharedApplication; @property(readonly) NSSet *connectedScenes; @end
@interface UIDevice : NSObject @property(class, readonly) UIDevice *currentDevice; @property(readonly) NSString *name; @end
""",
                    encoding="utf-8",
                )
                impl_stubs = """
@implementation NSLayoutConstraint + (void)activateConstraints:(NSArray *)c {} @end
@implementation NSLayoutAnchor - (NSLayoutConstraint *)constraintEqualToAnchor:(id)a { return [NSLayoutConstraint new]; } - (NSLayoutConstraint *)constraintEqualToAnchor:(id)a constant:(CGFloat)c { return [NSLayoutConstraint new]; } - (NSLayoutConstraint *)constraintEqualToConstant:(CGFloat)c { return [NSLayoutConstraint new]; } - (NSLayoutConstraint *)constraintGreaterThanOrEqualToConstant:(CGFloat)c { return [NSLayoutConstraint new]; } @end
@implementation UILayoutGuide @end
@implementation CALayer @end
@implementation UIColor + (UIColor *)labelColor { return nil; } + (UIColor *)secondaryLabelColor { return nil; } + (UIColor *)systemGroupedBackgroundColor { return nil; } + (UIColor *)secondarySystemGroupedBackgroundColor { return nil; } + (UIColor *)systemBackgroundColor { return nil; } + (UIColor *)systemRedColor { return nil; } @end
@implementation UIFont + (UIFont *)preferredFontForTextStyle:(NSString *)s { return nil; } + (UIFont *)systemFontOfSize:(CGFloat)s weight:(UIFontWeight)w { return nil; } + (UIFont *)monospacedSystemFontOfSize:(CGFloat)s weight:(UIFontWeight)w { return nil; } @end
@implementation UIImage + (UIImage *)systemImageNamed:(NSString *)n { return nil; } @end
@implementation UIView - (void)addSubview:(UIView *)v {} - (void)removeFromSuperview {} - (BOOL)becomeFirstResponder { return NO; } - (instancetype)initWithFrame:(CGRect)f { return [super init]; } @end
@implementation UIScrollView @end
@implementation UIStackView - (instancetype)initWithArrangedSubviews:(NSArray *)a { return [super init]; } - (void)addArrangedSubview:(UIView *)v {} - (void)setCustomSpacing:(CGFloat)s afterView:(UIView *)v {} @end
@implementation UILabel @end
@implementation UIImageView - (instancetype)initWithImage:(UIImage *)i { return [super init]; } @end
@implementation UIControl - (void)addTarget:(id)t action:(SEL)a forControlEvents:(UIControlEvents)e {} @end
@implementation UITextField @end
@implementation UISwitch @end
@implementation UISegmentedControl - (instancetype)initWithItems:(NSArray *)i { return [super init]; } @end
@implementation UIButtonConfiguration + (instancetype)tintedButtonConfiguration { return [self new]; } + (instancetype)filledButtonConfiguration { return [self new]; } @end
@implementation UIButton + (instancetype)buttonWithType:(UIButtonType)t { return [self new]; } - (void)setImage:(UIImage *)i forState:(UIControlState)s {} @end
@implementation UIBarButtonItem - (instancetype)initWithBarButtonSystemItem:(UIBarButtonSystemItem)s target:(id)t action:(SEL)a { return [super init]; } @end
@implementation UINavigationItem @end
@implementation UINavigationBar @end
@implementation UISheetPresentationControllerDetent + (id)largeDetent { return nil; } @end
@implementation UISheetPresentationController @end
@implementation UIViewController - (void)viewDidLoad {} - (void)viewWillAppear:(BOOL)a {} - (void)viewWillDisappear:(BOOL)a {} - (void)presentViewController:(UIViewController *)vc animated:(BOOL)a completion:(void(^)(void))c {} - (void)dismissViewControllerAnimated:(BOOL)a completion:(void(^)(void))c {} @end
@implementation UINavigationController - (instancetype)initWithRootViewController:(UIViewController *)vc { return [super init]; } @end
@implementation UIWindow - (instancetype)initWithWindowScene:(UIWindowScene *)s { return [super init]; } - (void)makeKeyWindow {} - (void)makeKeyAndVisible {} @end
@implementation UIScene @end
@implementation UIWindowScene @end
@implementation UIApplication + (UIApplication *)sharedApplication { static UIApplication *a; static dispatch_once_t o; dispatch_once(&o, ^{ a = [self new]; }); return a; } @end
@implementation UIDevice + (UIDevice *)currentDevice { static UIDevice *d; static dispatch_once_t o; dispatch_once(&o, ^{ d = [self new]; }); return d; } - (NSString *)name { return @"Test"; } @end
"""
                harness = work / "test.m"
                harness.write_text(OBJC_HARNESS + "\n" + impl_stubs, encoding="utf-8")
                binary = work / "test-bin"
                subprocess.run(
                    [
                        "clang", "-fobjc-arc", "-fblocks", "-Wall", "-Wno-unused-parameter",
                        "-Wno-deprecated-declarations", "-Wno-nullability-completeness",
                        "-I", str(work), "-I", str(IOS_ROOT / "clients" / "ios"),
                        "-framework", "Foundation", "-framework", "Security",
                        str(harness), "-o", str(binary),
                    ],
                    check=True,
                    cwd=IOS_ROOT / "tests",
                )
                subprocess.run(
                    [str(binary), f"http://127.0.0.1:{port}", f"http://127.0.0.1:{dead_port}"],
                    check=True,
                    timeout=15,
                )
                self.assertEqual(len(received), 1)
                self.assertEqual(received[0][0], "/local/device/revoke")
                self.assertEqual(received[0][1], "Bearer tok-live-123")
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
