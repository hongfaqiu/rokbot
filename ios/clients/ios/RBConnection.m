#import "RBConnection.h"
#import "RBAvatarStyle.h"
#import "RBDeviceIdentity.h"
#import "RBModels.h"
#import "RBGroupCreate.h"
#import "RBSuggestions.h"
#import "RBMigrate.h"
#import "RBTheme.h"
#import "RBUpdater.h"
#import "RBNetwork.h"
#import "RBNetworkScanner.h"
#import "RBHTTP.h"
#import "RBHermes.h"
#import "RBProfile.h"
#import "RBPush.h"
#import "RBDiagnostics.h"
#import "RBLocalize.h"
#import "RBAppIntents.h"
#import <Security/Security.h>
#import <stdatomic.h>

static NSString *RBConnAsString(id value) {
  return [value isKindOfClass:NSString.class] ? (NSString *)value : nil;
}

static BOOL RBConnBoolValue(id value, BOOL fallback) {
  if ([value isKindOfClass:NSNumber.class])
    return [(NSNumber *)value boolValue];
  if ([value isKindOfClass:NSString.class])
    return [(NSString *)value boolValue];
  return fallback;
}

static NSString *const RBURLKey = @"RokBotLocal.serverURL";
static NSString *RBService(void) {
  return [@"dev.rokbot.local." stringByAppendingString:NSBundle.mainBundle.bundleIdentifier ?: @""];
}
static NSDictionary *RBKeychainQuery(void) {
  return @{
    (__bridge id)kSecClass : (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService : RBService(),
    (__bridge id)kSecAttrAccount : @"device-token"
  };
}
static NSString *RBReadToken(void) {
  NSMutableDictionary *q = [RBKeychainQuery() mutableCopy];
  q[(__bridge id)kSecReturnData] = @YES;
  CFTypeRef result = NULL;
  if (SecItemCopyMatching((__bridge CFDictionaryRef)q, &result) != errSecSuccess)
    return nil;
  return [[NSString alloc] initWithData:CFBridgingRelease(result) encoding:NSUTF8StringEncoding];
}
static BOOL RBWriteToken(NSString *token) {
  NSData *data = [token dataUsingEncoding:NSUTF8StringEncoding];
  if (!data.length)
    return NO;
  NSMutableDictionary *q = [RBKeychainQuery() mutableCopy];
  NSDictionary *attrs = @{
    (__bridge id)kSecValueData : data,
    (__bridge id)kSecAttrAccessible : (__bridge id)kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
  };
  OSStatus status = SecItemUpdate((__bridge CFDictionaryRef)q, (__bridge CFDictionaryRef)attrs);
  if (status == errSecItemNotFound) {
    [q addEntriesFromDictionary:attrs];
    status = SecItemAdd((__bridge CFDictionaryRef)q, NULL);
  }
  return status == errSecSuccess;
}
static UIViewController *RBTop(void) {
  UIWindow *window = nil;
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes)
    if ([scene isKindOfClass:UIWindowScene.class])
      for (UIWindow *w in ((UIWindowScene *)scene).windows)
        if (w.isKeyWindow)
          window = w;
  UIViewController *vc = window.rootViewController;
  while (vc.presentedViewController)
    vc = vc.presentedViewController;
  return vc;
}
@interface RBPairController : UIViewController <NSURLSessionTaskDelegate>
@property(nonatomic, strong) UITextField *address;
@property(nonatomic, strong) RBSegmentControl *authMode;
@property(nonatomic, strong) UITextField *key;
@property(nonatomic, strong) UILabel *status;
@property(nonatomic, strong) UIButton *connect;
@property(nonatomic, strong) UIButton *disconnectButton;
@property(nonatomic, strong) UISwitch *tailcat;
@property(nonatomic, strong) UILabel *networkLabel;
@property(nonatomic, strong) NSTimer *networkTimer;
@property(nonatomic, strong) NSURLSession *pairSession;
@property(nonatomic, assign) BOOL editingConnection;
@property(nonatomic, assign) BOOL cancelled;
- (void)renderConnection;
// Shown by RBShowRequiredPairing(): full-screen, no close control, cannot be
// dismissed until pairing succeeds.
@property(nonatomic, assign) BOOL required;
- (void)finishPairing:(void (^)(void))completion;
@end
static UIWindow *RBRequiredPairingWindow;
static __weak UIWindow *RBRequiredPairingPreviousKeyWindow;
static UIWindowScene *RBRequiredPairingScene(UIWindow **appWindowOut) {
  UIWindowScene *fallback = nil;
  UIWindow *fallbackWindow = nil;
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
    if (![scene isKindOfClass:UIWindowScene.class]) continue;
    if (scene.activationState != UISceneActivationStateForegroundActive &&
        scene.activationState != UISceneActivationStateForegroundInactive) continue;
    UIWindow *appWindow = nil;
    for (UIWindow *w in ((UIWindowScene *)scene).windows) {
      if (w == RBRequiredPairingWindow || w.hidden) continue;
      if (w.isKeyWindow) { appWindow = w; break; }
      if (!appWindow && w.rootViewController) appWindow = w;
    }
    if (!appWindow) continue;
    if (scene.activationState == UISceneActivationStateForegroundActive) {
      if (appWindowOut) *appWindowOut = appWindow;
      return (UIWindowScene *)scene;
    }
    if (!fallback) { fallback = (UIWindowScene *)scene; fallbackWindow = appWindow; }
  }
  if (appWindowOut) *appWindowOut = fallbackWindow;
  return fallback;
}
BOOL RBRequiredPairingVisible(void) {
  return RBRequiredPairingWindow != nil && !RBRequiredPairingWindow.hidden;
}
void RBDismissRequiredPairing(void) {
  UIWindow *window = RBRequiredPairingWindow;
  if (!window) return;
  RBRequiredPairingWindow = nil;
  window.hidden = YES;
  window.rootViewController = nil;
  UIWindow *previous = RBRequiredPairingPreviousKeyWindow;
  RBRequiredPairingPreviousKeyWindow = nil;
  if (previous && !previous.hidden) [previous makeKeyWindow];
  RBDiagnosticsEvent(@"pairing.required.dismiss", @{});
}
@interface RBConnection ()
@property(nonatomic, readwrite) NSString *serverURL;
@property(nonatomic, readwrite) NSString *deviceToken;
@property(nonatomic, readwrite) NSURL *gatewayBundleURL;
@property(nonatomic, weak) RBPairController *controller;
@end
@implementation RBConnection {
  NSString *_serverURL;
  NSString *_deviceToken;
  _Atomic(BOOL) _paired;
  _Atomic(BOOL) _disconnecting;
  NSURL *_gatewayBundleURL;
}
+ (instancetype)shared {
  static RBConnection *v;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    v = [self new];
  });
  return v;
}
- (NSString *)serverURL {
  @synchronized (self) { return _serverURL; }
}
- (void)setServerURL:(NSString *)serverURL {
  @synchronized (self) {
    _serverURL = [serverURL copy];
    atomic_store_explicit(&_paired, _serverURL.length > 0 && _deviceToken.length > 0, memory_order_release);
  }
}
- (NSString *)deviceToken {
  @synchronized (self) { return _deviceToken; }
}
- (BOOL)isPaired {
  return atomic_load_explicit(&_paired, memory_order_acquire);
}
- (void)setDeviceToken:(NSString *)deviceToken {
  @synchronized (self) {
    _deviceToken = [deviceToken copy];
    atomic_store_explicit(&_paired, _serverURL.length > 0 && _deviceToken.length > 0, memory_order_release);
  }
}
- (NSURL *)gatewayBundleURL {
  @synchronized (self) { return _gatewayBundleURL; }
}
- (void)setGatewayBundleURL:(NSURL *)gatewayBundleURL {
  @synchronized (self) { _gatewayBundleURL = [gatewayBundleURL copy]; }
}
- (BOOL)restore:(NSError **)error {
  RBDiagnosticsEvent(@"connection.credentials.begin", @{});
  self.serverURL = RBNetworkRestore([NSUserDefaults.standardUserDefaults stringForKey:RBURLKey]);
  self.deviceToken = RBReadToken();
  RBSyncAppIntentCredentials();
  RBDiagnosticsEvent(@"connection.credentials.end", @{});
  if (!self.serverURL.length || !self.deviceToken.length)
    return NO;
  RBRestoreProfileCache();
  RBDiagnosticsEvent(@"connection.script.begin", @{});
  self.gatewayBundleURL = [RBHermes writeGateway:self.serverURL
                                           token:self.deviceToken
                                       resources:self.resourcesURL
                                           error:error];
  RBDiagnosticsEvent(@"connection.script.end", @{});
  return self.gatewayBundleURL != nil;
}
- (void)show {
  if (!self.isPaired && RBShowRequiredPairing()) return;
  if (self.controller) {
    if (self.controller.address) [self.controller.address becomeFirstResponder];
    return;
  }
  RBPairController *vc = [RBPairController new];
  self.controller = vc;
  UINavigationController *nav = [[UINavigationController alloc] initWithRootViewController:vc];
  nav.modalPresentationStyle = UIModalPresentationPageSheet;
  if (@available(iOS 15.0, *)) {
    nav.sheetPresentationController.detents = @[ UISheetPresentationControllerDetent.largeDetent ];
    nav.sheetPresentationController.prefersGrabberVisible = YES;
  }
  [RBTop() presentViewController:nav animated:YES completion:nil];
}
- (void)finishDisconnect {
  RBNetworkClear();
  RBClearProfileCache();
  RBClearModelOnboardingState();
  RBSuggestionsInvalidate();
  // Keep client-device-id and RokBotLocal.clientDeviceId across disconnect so
  // re-pairing reuses the same Host device slot without creating duplicates.
  SecItemDelete((__bridge CFDictionaryRef)RBKeychainQuery());
  [NSUserDefaults.standardUserDefaults removeObjectForKey:RBURLKey];
  [NSUserDefaults.standardUserDefaults removeObjectForKey:@"RokBotLocal.deviceId"];
  [NSUserDefaults.standardUserDefaults synchronize];
  if (self.gatewayBundleURL)
    [NSFileManager.defaultManager removeItemAtURL:self.gatewayBundleURL error:nil];
  NSURL *cachesDir =
      [NSFileManager.defaultManager URLsForDirectory:NSCachesDirectory
                                           inDomains:NSUserDomainMask]
          .firstObject;
  if (cachesDir) {
    [NSFileManager.defaultManager removeItemAtURL:[cachesDir URLByAppendingPathComponent:@"RokBotPaired" isDirectory:YES] error:nil];
    [NSFileManager.defaultManager removeItemAtURL:[cachesDir URLByAppendingPathComponent:@"GrokBotPaired" isDirectory:YES] error:nil];
  }
  self.gatewayBundleURL = nil;
  self.serverURL = nil;
  self.deviceToken = nil;
  atomic_store_explicit(&_disconnecting, NO, memory_order_release);
  RBSyncAppIntentCredentials();
  if (self.didDisconnect)
    self.didDisconnect();
  // Back to the forced pairing window (RBShowRequiredPairing replaces an open
  // dismissible connection sheet); retry once if no app window is ready yet.
  if (!RBShowRequiredPairing()) {
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(300 * NSEC_PER_MSEC)),
                   dispatch_get_main_queue(), ^{
                     RBShowRequiredPairing();
                   });
  }
  RBReloadReactHost();
}
- (void)disconnect {
  BOOL expected = NO;
  if (!atomic_compare_exchange_strong_explicit(&_disconnecting, &expected, YES,
                                               memory_order_acq_rel, memory_order_acquire)) {
    return;
  }
  NSString *base = self.serverURL;
  NSString *token = self.deviceToken;
  NSURL *revokeURL = base.length
      ? [NSURL URLWithString:[base stringByAppendingString:@"/local/device/revoke"]]
      : nil;
  if (!revokeURL || !token.length) {
    if ([NSThread isMainThread])
      [self finishDisconnect];
    else
      dispatch_async(dispatch_get_main_queue(), ^{ [self finishDisconnect]; });
    return;
  }
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:revokeURL];
  request.HTTPMethod = @"POST";
  request.timeoutInterval = 5.0;
  [request setValue:[@"Bearer " stringByAppendingString:token] forHTTPHeaderField:@"Authorization"];
  [request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
  request.HTTPBody = [@"{}" dataUsingEncoding:NSUTF8StringEncoding];

  __block _Atomic(BOOL) completed = NO;
  __weak RBConnection *weakSelf = self;
  void (^completeOnce)(NSInteger, NSError *) = ^(NSInteger status, NSError *error) {
    BOOL done = NO;
    if (!atomic_compare_exchange_strong_explicit(&completed, &done, YES,
                                                 memory_order_acq_rel, memory_order_acquire)) {
      return;
    }
    RBDiagnosticsEvent(@"connection.revoke", @{
      @"status" : @(status),
      @"error" : @(error ? error.code : 0)
    });
    dispatch_async(dispatch_get_main_queue(), ^{
      [weakSelf finishDisconnect];
    });
  };
  NSURLSessionDataTask *task =
      [RBHTTPSession() dataTaskWithRequest:request
                         completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
                           NSInteger status = [response isKindOfClass:NSHTTPURLResponse.class]
                               ? ((NSHTTPURLResponse *)response).statusCode
                               : 0;
                           completeOnce(status, error);
                         }];
  [task resume];
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(5.5 * NSEC_PER_SEC)),
                 dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
                   if (!atomic_load_explicit(&completed, memory_order_acquire)) {
                     [task cancel];
                     completeOnce(0, [NSError errorWithDomain:NSURLErrorDomain
                                                         code:NSURLErrorTimedOut
                                                     userInfo:nil]);
                   }
                 });
}
@end
BOOL RBShowRequiredPairing(void) {
  if (!NSThread.isMainThread) {
    dispatch_async(dispatch_get_main_queue(), ^{ RBShowRequiredPairing(); });
    return NO;
  }
  RBConnection *connection = RBConnection.shared;
  if (connection.isPaired) {
    RBDismissRequiredPairing();
    return YES;
  }
  if (RBRequiredPairingVisible()) {
    [RBRequiredPairingWindow makeKeyAndVisible];
    return YES;
  }
  UIWindow *appWindow = nil;
  UIWindowScene *scene = RBRequiredPairingScene(&appWindow);
  // The app window must exist first so this window reliably sits above it.
  if (!scene || !appWindow) return NO;
  RBPairController *existing = connection.controller;
  if (existing && !existing.required) {
    // A dismissible connection sheet is open; replace it with the required page.
    existing.cancelled = YES;
    [existing.pairSession invalidateAndCancel];
    existing.pairSession = nil;
    RBNetworkRollback();
    [existing.navigationController.presentingViewController dismissViewControllerAnimated:NO completion:nil];
    connection.controller = nil;
  }
  RBPairController *vc = [RBPairController new];
  vc.required = YES;
  vc.modalInPresentation = YES;
  connection.controller = vc;
  UINavigationController *nav = [[UINavigationController alloc] initWithRootViewController:vc];
  nav.modalPresentationStyle = UIModalPresentationFullScreen;
  nav.modalInPresentation = YES;
  UIWindow *window = [[UIWindow alloc] initWithWindowScene:scene];
  window.windowLevel = appWindow.windowLevel + 1;
  window.backgroundColor = UIColor.systemGroupedBackgroundColor;
  window.accessibilityIdentifier = @"rokbot.pairing.required";
  window.rootViewController = nav;
  RBRequiredPairingPreviousKeyWindow = appWindow;
  RBRequiredPairingWindow = window;
  [window makeKeyAndVisible];
  RBDiagnosticsEvent(@"pairing.required.show", @{});
  return YES;
}
@implementation RBPairController
- (void)URLSession:(NSURLSession *)session
                          task:(NSURLSessionTask *)task
    willPerformHTTPRedirection:(NSHTTPURLResponse *)response
                    newRequest:(NSURLRequest *)request
             completionHandler:(void (^)(NSURLRequest *))completionHandler {
  completionHandler(nil);
}
- (UITextField *)field:(NSString *)placeholder secure:(BOOL)secure {
  UITextField *f = [UITextField new];
  f.placeholder = placeholder;
  f.secureTextEntry = secure;
  f.borderStyle = UITextBorderStyleNone;
  f.backgroundColor = UIColor.secondarySystemGroupedBackgroundColor;
  f.layer.cornerRadius = 16;
  f.leftView = [[UIView alloc] initWithFrame:CGRectMake(0, 0, 16, 1)];
  f.leftViewMode = UITextFieldViewModeAlways;
  f.textColor = UIColor.labelColor;
  f.autocapitalizationType = UITextAutocapitalizationTypeNone;
  f.autocorrectionType = UITextAutocorrectionTypeNo;
  f.clearButtonMode = UITextFieldViewModeWhileEditing;
  f.font = [UIFont preferredFontForTextStyle:UIFontTextStyleBody];
  [f.heightAnchor constraintEqualToConstant:50].active = YES;
  return f;
}
- (UILabel *)label:(NSString *)text size:(CGFloat)size weight:(UIFontWeight)weight {
  UILabel *label = [UILabel new];
  label.text = text; label.font = [UIFont systemFontOfSize:size weight:weight];
  label.textColor = UIColor.labelColor; label.numberOfLines = 0;
  return label;
}
- (void)viewDidLoad {
  [super viewDidLoad]; [self renderConnection];
}
- (void)viewWillAppear:(BOOL)animated {
  [super viewWillAppear:animated];
  [self.networkTimer invalidate];
  self.networkTimer = nil;
  if (RBNetworkEnabled()) {
    __weak RBPairController *weak = self;
    self.networkTimer = [NSTimer scheduledTimerWithTimeInterval:2 repeats:YES block:^(NSTimer *timer) {
      [weak updateNetworkState];
    }];
    self.networkTimer.tolerance = 0.5;
  }
  [self updateNetworkState];
}
- (void)viewWillDisappear:(BOOL)animated {
  [self.networkTimer invalidate]; self.networkTimer = nil;
  [super viewWillDisappear:animated];
}
- (void)dealloc {
  [_networkTimer invalidate];
  [_pairSession invalidateAndCancel];
}
- (void)updateNetworkState {
  if (self.editingConnection || !RBConnection.shared.deviceToken.length) return;
  if (!RBNetworkEnabled()) { self.networkLabel.text = RBL(@"已连接", @"Connected"); return; }
  self.networkLabel.text = RBConnBoolValue(RBNetworkStatus()[@"healthy"], NO)
    ? RBL(@"已连接 · Tailcat", @"Connected · Tailcat")
    : RBL(@"正在重新连接 · Tailcat", @"Reconnecting · Tailcat");
}
- (void)renderConnection {
  for (UIView *subview in self.view.subviews) [subview removeFromSuperview];
  self.navigationController.navigationBar.tintColor = UIColor.labelColor;
  self.title = RBL(@"连接设置", @"Connection");
  self.view.backgroundColor = UIColor.systemGroupedBackgroundColor;
  // The required pairing page has no close/dismiss control.
  self.navigationItem.hidesBackButton = self.required;
  self.navigationItem.rightBarButtonItem = self.required ? nil :
      [[UIBarButtonItem alloc] initWithBarButtonSystemItem:UIBarButtonSystemItemClose
                                                    target:self action:@selector(close)];
  if (self.required) {
    self.modalInPresentation = YES;
    self.navigationController.modalInPresentation = YES;
  }
  UIScrollView *scroll = [UIScrollView new];
  scroll.translatesAutoresizingMaskIntoConstraints = NO;
  [self.view addSubview:scroll];
  UIStackView *stack = [UIStackView new];
  stack.axis = UILayoutConstraintAxisVertical; stack.spacing = 24;
  stack.translatesAutoresizingMaskIntoConstraints = NO; [scroll addSubview:stack];
  [NSLayoutConstraint activateConstraints:@[
    [scroll.leadingAnchor constraintEqualToAnchor:self.view.leadingAnchor],
    [scroll.trailingAnchor constraintEqualToAnchor:self.view.trailingAnchor],
    [scroll.topAnchor constraintEqualToAnchor:self.view.safeAreaLayoutGuide.topAnchor],
    [scroll.bottomAnchor constraintEqualToAnchor:self.view.bottomAnchor],
    [stack.leadingAnchor constraintEqualToAnchor:scroll.contentLayoutGuide.leadingAnchor constant:24],
    [stack.trailingAnchor constraintEqualToAnchor:scroll.contentLayoutGuide.trailingAnchor constant:-24],
    [stack.topAnchor constraintEqualToAnchor:scroll.contentLayoutGuide.topAnchor constant:32],
    [stack.bottomAnchor constraintEqualToAnchor:scroll.contentLayoutGuide.bottomAnchor constant:-32],
    [stack.widthAnchor constraintEqualToAnchor:scroll.frameLayoutGuide.widthAnchor constant:-48]
  ]];
  BOOL connected = RBConnection.shared.deviceToken.length > 0 && !self.editingConnection;
  UIImageView *icon = [[UIImageView alloc] initWithImage:[UIImage systemImageNamed:connected ? @"checkmark.circle.fill" : @"link.circle.fill"]];
  icon.tintColor = UIColor.labelColor; icon.contentMode = UIViewContentModeScaleAspectFit;
  [icon.heightAnchor constraintEqualToConstant:52].active = YES;
  UILabel *heading = [self label:connected ? RBProfileHostName() : RBL(@"连接你的 RokBot", @"Connect your RokBot") size:28 weight:UIFontWeightBold];
  heading.textAlignment = NSTextAlignmentCenter;
  UILabel *subtitle = [self label:connected ? (RBNetworkEnabled() ? RBL(@"已连接 · Tailcat", @"Connected · Tailcat") : RBL(@"已连接", @"Connected")) : (self.editingConnection ? RBL(@"编辑连接", @"Edit connection") : RBL(@"地址与配对码", @"Host address and pairing code")) size:15 weight:UIFontWeightRegular];
  self.networkLabel = subtitle;
  [self updateNetworkState];
  subtitle.textColor = UIColor.secondaryLabelColor; subtitle.textAlignment = NSTextAlignmentCenter;
  UIStackView *hero = [[UIStackView alloc] initWithArrangedSubviews:@[icon, heading, subtitle]];
  hero.axis = UILayoutConstraintAxisVertical; hero.spacing = 12;
  [stack addArrangedSubview:hero]; [stack setCustomSpacing:36 afterView:hero];
  if (connected) {
    UIView *card = [UIView new]; card.backgroundColor = UIColor.secondarySystemGroupedBackgroundColor;
    card.layer.cornerRadius = 20; [card.heightAnchor constraintGreaterThanOrEqualToConstant:96].active = YES;
    UIImageView *avatar = [[UIImageView alloc] initWithImage:RBProfileAvatar() ?: [UIImage systemImageNamed:@"person.crop.circle.fill"]];
    avatar.tintColor = UIColor.secondaryLabelColor; avatar.contentMode = UIViewContentModeScaleAspectFill;
    avatar.layer.cornerRadius = 24; avatar.clipsToBounds = YES;
    UILabel *name = [self label:RBProfileName() size:17 weight:UIFontWeightSemibold];
    UILabel *device = [self label:UIDevice.currentDevice.name size:14 weight:UIFontWeightRegular];
    device.textColor = UIColor.secondaryLabelColor;
    UIStackView *identity = [[UIStackView alloc] initWithArrangedSubviews:@[name, device]];
    identity.axis = UILayoutConstraintAxisVertical; identity.spacing = 5;
    UIStackView *row = [[UIStackView alloc] initWithArrangedSubviews:@[avatar, identity]];
    row.axis = UILayoutConstraintAxisHorizontal; row.alignment = UIStackViewAlignmentCenter; row.spacing = 16;
    row.translatesAutoresizingMaskIntoConstraints = NO; [card addSubview:row];
    [NSLayoutConstraint activateConstraints:@[
      [avatar.widthAnchor constraintEqualToConstant:48], [avatar.heightAnchor constraintEqualToConstant:48],
      [row.leadingAnchor constraintEqualToAnchor:card.leadingAnchor constant:20],
      [row.trailingAnchor constraintEqualToAnchor:card.trailingAnchor constant:-20],
      [row.topAnchor constraintEqualToAnchor:card.topAnchor constant:20],
      [row.bottomAnchor constraintEqualToAnchor:card.bottomAnchor constant:-20]
    ]];
    [stack addArrangedSubview:card];
    UIButton *modelsButton = [UIButton buttonWithType:UIButtonTypeSystem];
    UIButtonConfiguration *modelsConfig = UIButtonConfiguration.tintedButtonConfiguration;
    modelsConfig.title = RBL(@"模型配置", @"Model Config");
    modelsConfig.cornerStyle = UIButtonConfigurationCornerStyleCapsule;
    modelsConfig.baseForegroundColor = UIColor.labelColor;
    modelsConfig.baseBackgroundColor = UIColor.secondarySystemGroupedBackgroundColor;
    modelsButton.configuration = modelsConfig;
    modelsButton.accessibilityIdentifier = @"rokbot.host.models";
    [modelsButton.heightAnchor constraintEqualToConstant:50].active = YES;
    [modelsButton addTarget:self action:@selector(openModels) forControlEvents:UIControlEventTouchUpInside];
    [stack addArrangedSubview:modelsButton];
    UIButton *suggestionsButton = [UIButton buttonWithType:UIButtonTypeSystem];
    UIButtonConfiguration *suggestionsConfig = UIButtonConfiguration.tintedButtonConfiguration;
    suggestionsConfig.title = RBL(@"输入建议", @"Input Suggestions");
    suggestionsConfig.cornerStyle = UIButtonConfigurationCornerStyleCapsule;
    suggestionsConfig.baseForegroundColor = UIColor.labelColor;
    suggestionsConfig.baseBackgroundColor = UIColor.secondarySystemGroupedBackgroundColor;
    suggestionsButton.configuration = suggestionsConfig;
    suggestionsButton.accessibilityIdentifier = @"rokbot.host.suggestions";
    [suggestionsButton.heightAnchor constraintEqualToConstant:50].active = YES;
    [suggestionsButton addTarget:self action:@selector(openSuggestions) forControlEvents:UIControlEventTouchUpInside];
    [stack addArrangedSubview:suggestionsButton];
    UIButton *migrateButton = [UIButton buttonWithType:UIButtonTypeSystem];
    UIButtonConfiguration *migrateConfig = UIButtonConfiguration.tintedButtonConfiguration;
    migrateConfig.title = RBL(@"数据迁移", @"Data Migration");
    migrateConfig.cornerStyle = UIButtonConfigurationCornerStyleCapsule;
    migrateConfig.baseForegroundColor = UIColor.labelColor;
    migrateConfig.baseBackgroundColor = UIColor.secondarySystemGroupedBackgroundColor;
    migrateButton.configuration = migrateConfig;
    migrateButton.accessibilityIdentifier = @"rokbot.host.migrate";
    [migrateButton.heightAnchor constraintEqualToConstant:50].active = YES;
    [migrateButton addTarget:self action:@selector(openMigrate) forControlEvents:UIControlEventTouchUpInside];
    [stack addArrangedSubview:migrateButton];
    UIButton *groupButton = [UIButton buttonWithType:UIButtonTypeSystem];
    UIButtonConfiguration *groupConfig = UIButtonConfiguration.tintedButtonConfiguration;
    groupConfig.title = RBL(@"新建群聊", @"New Group Chat");
    groupConfig.cornerStyle = UIButtonConfigurationCornerStyleCapsule;
    groupConfig.baseForegroundColor = UIColor.labelColor;
    groupConfig.baseBackgroundColor = UIColor.secondarySystemGroupedBackgroundColor;
    groupButton.configuration = groupConfig;
    groupButton.accessibilityIdentifier = @"rokbot.host.create-group";
    [groupButton.heightAnchor constraintEqualToConstant:50].active = YES;
    [groupButton addTarget:self action:@selector(openCreateGroup) forControlEvents:UIControlEventTouchUpInside];
    [stack addArrangedSubview:groupButton];
    UIButton *avatarStyleButton = [UIButton buttonWithType:UIButtonTypeSystem];
    UIButtonConfiguration *avatarConfig = UIButtonConfiguration.tintedButtonConfiguration;
    avatarConfig.title = RBL(@"Bot 动态图标", @"Bot Avatar Style");
    avatarConfig.cornerStyle = UIButtonConfigurationCornerStyleCapsule;
    avatarConfig.baseForegroundColor = UIColor.labelColor;
    avatarConfig.baseBackgroundColor = UIColor.secondarySystemGroupedBackgroundColor;
    avatarStyleButton.configuration = avatarConfig;
    avatarStyleButton.accessibilityIdentifier = @"rokbot.host.avatar-style";
    [avatarStyleButton.heightAnchor constraintEqualToConstant:50].active = YES;
    [avatarStyleButton addTarget:self action:@selector(openAvatarStyle) forControlEvents:UIControlEventTouchUpInside];
    [stack addArrangedSubview:avatarStyleButton];
    UIButton *updatesButton = [UIButton buttonWithType:UIButtonTypeSystem];
    UIButtonConfiguration *updatesConfig = UIButtonConfiguration.tintedButtonConfiguration;
    updatesConfig.title = RBL(@"检查更新", @"Check for Updates");
    updatesConfig.cornerStyle = UIButtonConfigurationCornerStyleCapsule;
    updatesConfig.baseForegroundColor = UIColor.labelColor;
    updatesConfig.baseBackgroundColor = UIColor.secondarySystemGroupedBackgroundColor;
    updatesButton.configuration = updatesConfig;
    updatesButton.accessibilityIdentifier = @"rokbot.host.updates";
    [updatesButton.heightAnchor constraintEqualToConstant:50].active = YES;
    [updatesButton addTarget:self action:@selector(openUpdater) forControlEvents:UIControlEventTouchUpInside];
    [stack addArrangedSubview:updatesButton];
    UIButton *edit = [UIButton buttonWithType:UIButtonTypeSystem];
    UIButtonConfiguration *editConfig = UIButtonConfiguration.tintedButtonConfiguration;
    editConfig.title = RBL(@"编辑连接", @"Edit connection"); editConfig.cornerStyle = UIButtonConfigurationCornerStyleCapsule;
    editConfig.baseForegroundColor = UIColor.labelColor;
    editConfig.baseBackgroundColor = UIColor.secondarySystemGroupedBackgroundColor;
    edit.configuration = editConfig;
    edit.accessibilityIdentifier = @"rokbot.host.edit";
    [edit.heightAnchor constraintEqualToConstant:50].active = YES;
    [edit addTarget:self action:@selector(editConnection) forControlEvents:UIControlEventTouchUpInside];
    [stack addArrangedSubview:edit];
    UIButton *disconnect = [UIButton buttonWithType:UIButtonTypeSystem];
    UIButtonConfiguration *config = UIButtonConfiguration.tintedButtonConfiguration;
    config.title = RBL(@"退出连接", @"Disconnect"); config.cornerStyle = UIButtonConfigurationCornerStyleCapsule;
    config.baseForegroundColor = UIColor.systemRedColor; config.baseBackgroundColor = UIColor.secondarySystemGroupedBackgroundColor;
    disconnect.configuration = config; disconnect.accessibilityIdentifier = @"rokbot.host.disconnect";
    [disconnect.heightAnchor constraintEqualToConstant:50].active = YES;
    [disconnect addTarget:self action:@selector(disconnect) forControlEvents:UIControlEventTouchUpInside];
    self.disconnectButton = disconnect;
    [stack addArrangedSubview:disconnect];
    return;
  }
  self.address = [self field:@"https://bot.example.com" secure:NO];
  self.address.keyboardType = UIKeyboardTypeURL;
  self.address.text = RBNetworkAddress().length ? RBNetworkAddress() : [NSUserDefaults.standardUserDefaults stringForKey:RBURLKey];
  self.tailcat = [UISwitch new]; self.tailcat.on = RBNetworkEnabled();
  self.tailcat.accessibilityIdentifier = @"rokbot.host.tailcat";
  UILabel *networkLabel = [self label:@"Tailcat" size:17 weight:UIFontWeightMedium];
  UIButton *scan = [UIButton buttonWithType:UIButtonTypeSystem];
  [scan setImage:[UIImage systemImageNamed:@"qrcode.viewfinder"] forState:UIControlStateNormal];
  scan.tintColor = UIColor.labelColor; scan.accessibilityLabel = RBL(@"扫描连接二维码", @"Scan connection code");
  [scan.widthAnchor constraintEqualToConstant:44].active = YES; [scan.heightAnchor constraintEqualToConstant:44].active = YES;
  [scan addTarget:self action:@selector(scanConnection) forControlEvents:UIControlEventTouchUpInside];
  UIStackView *networkRow = [[UIStackView alloc] initWithArrangedSubviews:@[networkLabel, scan, self.tailcat]];
  networkRow.alignment = UIStackViewAlignmentCenter;
  [self.tailcat addTarget:self action:@selector(networkChanged) forControlEvents:UIControlEventValueChanged];
  [stack addArrangedSubview:networkRow];
  [self networkChanged];
  self.address.accessibilityIdentifier = @"rokbot.host.address";
  self.authMode = [[RBSegmentControl alloc] initWithItems:@[
    RBL(@"配对码", @"Pairing Code"),
    RBL(@"管理员密码", @"Admin Password")
  ]];
  self.authMode.selectedSegmentIndex = 0;
  self.authMode.accessibilityIdentifier = @"rokbot.host.auth-mode";
  self.authMode.hidden = self.editingConnection;
  [self.authMode addTarget:self action:@selector(authModeChanged) forControlEvents:UIControlEventValueChanged];
  self.key = [self field:RBL(@"配对码", @"Pairing code") secure:NO];
  self.key.accessibilityIdentifier = @"rokbot.host.pairing-key";
  self.key.autocapitalizationType = UITextAutocapitalizationTypeAllCharacters;
  self.key.font = [UIFont monospacedSystemFontOfSize:20 weight:UIFontWeightMedium];
  self.key.textContentType = UITextContentTypeOneTimeCode;
  UIStackView *fields = [[UIStackView alloc] initWithArrangedSubviews:@[self.address, self.authMode, self.key]];
  fields.axis = UILayoutConstraintAxisVertical; fields.spacing = 12;
  self.key.hidden = self.editingConnection;
  [stack addArrangedSubview:fields];
  self.connect = [UIButton buttonWithType:UIButtonTypeSystem];
  UIButtonConfiguration *config = UIButtonConfiguration.filledButtonConfiguration;
  config.title = self.editingConnection ? RBL(@"保存", @"Save") : RBL(@"连接", @"Connect"); config.cornerStyle = UIButtonConfigurationCornerStyleCapsule;
  config.baseBackgroundColor = UIColor.labelColor; config.baseForegroundColor = UIColor.systemBackgroundColor;
  self.connect.configuration = config;
  [self.connect.heightAnchor constraintEqualToConstant:50].active = YES;
  [self.connect addTarget:self action:@selector(pair) forControlEvents:UIControlEventTouchUpInside];
  self.connect.accessibilityIdentifier = @"rokbot.host.connect";
  [stack addArrangedSubview:self.connect];
  self.status = [self label:@"" size:13 weight:UIFontWeightRegular];
  self.status.textColor = UIColor.secondaryLabelColor; [stack addArrangedSubview:self.status];
}
- (void)openModels { RBShowModelsFrom(self); }
- (void)openSuggestions { RBShowSuggestionsSettingsFrom(self); }
- (void)openMigrate { RBShowMigrateFrom(self); }
- (void)openCreateGroup {
  UIViewController *presenter = self.navigationController.presentingViewController;
  if (presenter) [self.navigationController dismissViewControllerAnimated:YES completion:^{ RBShowCreateGroupFrom(presenter); }];
  else RBShowCreateGroupFrom(self);
}
- (void)openAvatarStyle { RBShowAvatarStyleFrom(self); }
- (void)openUpdater { RBShowUpdaterFrom(self); }
- (void)authModeChanged {
  BOOL passwordMode = (self.authMode.selectedSegmentIndex == 1);
  self.key.text = @"";
  if (passwordMode) {
    self.key.placeholder = RBL(@"管理员密码", @"Admin password");
    self.key.secureTextEntry = YES;
    self.key.autocapitalizationType = UITextAutocapitalizationTypeNone;
    self.key.font = [UIFont preferredFontForTextStyle:UIFontTextStyleBody];
    self.key.textContentType = UITextContentTypePassword;
  } else {
    self.key.placeholder = RBL(@"配对码", @"Pairing code");
    self.key.secureTextEntry = NO;
    self.key.autocapitalizationType = UITextAutocapitalizationTypeAllCharacters;
    self.key.font = [UIFont monospacedSystemFontOfSize:20 weight:UIFontWeightMedium];
    self.key.textContentType = UITextContentTypeOneTimeCode;
  }
}
- (void)scanConnection {
  RBPresentNetworkScanner(self, ^(NSString *address) { self.address.text = address; self.tailcat.on = YES; [self networkChanged]; });
}
- (void)editConnection { self.editingConnection = YES; [self renderConnection]; }
- (void)networkChanged { self.address.placeholder = self.tailcat.on ? @"tailcat://connect/…" : @"https://bot.example.com"; }
- (void)finishPairing:(void (^)(void))completion {
  if (self.required) {
    RBDismissRequiredPairing();
    if (completion) completion();
    return;
  }
  [self dismissViewControllerAnimated:YES completion:completion];
}
- (void)close {
  if (self.required) return;
  self.cancelled = YES;
  [self.pairSession invalidateAndCancel];
  self.pairSession = nil;
  RBNetworkRollback();
  [self dismissViewControllerAnimated:YES completion:nil];
}
- (void)disconnect {
  self.disconnectButton.enabled = NO;
  [RBConnection.shared disconnect];
}
- (void)fail:(NSString *)message {
  RBNetworkRollback();
  self.status.text = message;
  self.status.textColor = UIColor.systemRedColor;
  self.connect.enabled = YES;
}
- (void)updateConnection:(NSString *)base {
  NSString *token = RBConnection.shared.deviceToken;
  if (!token.length) {
    [self fail:RBL(@"无法验证此 Host 的设备凭据。", @"Could not verify this device with the Host.")];
    return;
  }
  NSURL *statusURL = [NSURL URLWithString:[base stringByAppendingString:@"/connect/status"]];
  if (!statusURL) {
    [self fail:RBL(@"无法验证此 Host 的设备凭据。", @"Could not verify this device with the Host.")];
    return;
  }
  self.connect.enabled = NO; self.status.text = RBL(@"正在连接…", @"Connecting…");
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:statusURL];
  request.timeoutInterval = 35;
  [request setValue:[@"Bearer " stringByAppendingString:token] forHTTPHeaderField:@"Authorization"];
  __weak typeof(self) weak = self;
  [[RBHTTPSession() dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
    NSDictionary *result = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    dispatch_async(dispatch_get_main_queue(), ^{
      typeof(self) strong = weak;
      if (!strong || strong.cancelled) return;
      NSInteger code = [response isKindOfClass:NSHTTPURLResponse.class] ? ((NSHTTPURLResponse *)response).statusCode : 0;
      NSDictionary *dict = [result isKindOfClass:NSDictionary.class] ? result : nil;
      BOOL disconnectedFlag = dict != nil && !RBConnBoolValue(dict[@"connected"], YES);
      if (error || code != 200 || disconnectedFlag) {
        NSString *errMsg = RBConnAsString(dict[@"error"]);
        [strong fail:errMsg.length ? errMsg : RBL(@"无法验证此 Host 的设备凭据。", @"Could not verify this device with the Host.")];
        return;
      }
      NSString *deviceId = RBConnAsString(dict[@"deviceId"]);
      if (deviceId.length) {
        [NSUserDefaults.standardUserDefaults setObject:deviceId forKey:@"RokBotLocal.deviceId"];
      }
      NSURL *bundle = [RBHermes writeGateway:base token:token resources:RBConnection.shared.resourcesURL error:nil];
      if (!bundle || !RBNetworkCommit()) { [strong fail:RBL(@"无法保存连接。", @"Could not save connection.")]; return; }
      [NSUserDefaults.standardUserDefaults setObject:RBNetworkAddress() forKey:RBURLKey];
      RBConnection.shared.serverURL = base; RBConnection.shared.gatewayBundleURL = bundle; RBSyncAppIntentCredentials();
      [strong finishPairing:^{ RBReloadReactHost(); if (RBConnection.shared.didConnect) RBConnection.shared.didConnect(); }];
    });
  }] resume];
}
- (void)pair {
  NSString *address = [self.address.text
      stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  NSError *networkError = nil;
  NSString *base = RBNetworkPrepare(address, self.tailcat.on, &networkError);
  if (!base) { [self fail:networkError.localizedDescription]; return; }
  if (self.editingConnection) { [self updateConnection:base]; return; }
  BOOL passwordMode = (self.authMode.selectedSegmentIndex == 1);
  NSString *rawKey = self.key.text ?: @"";
  NSString *key = passwordMode
      ? rawKey
      : [rawKey stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  if (!key.length) {
    [self fail:passwordMode ? RBL(@"请输入管理员密码。", @"Enter the admin password.")
                            : RBL(@"请输入配对码。", @"Enter a pairing code.")];
    return;
  }
  NSURL *pairURL = [NSURL URLWithString:[base stringByAppendingString:@"/connect/pair"]];
  if (!pairURL) {
    [self fail:RBL(@"无法连接 Host。", @"Could not connect to Host.")];
    return;
  }
  self.connect.enabled = NO;
  self.status.text = RBL(@"正在连接…", @"Connecting…");
  self.status.textColor = UIColor.secondaryLabelColor;
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:pairURL];
  request.HTTPMethod = @"POST";
  request.timeoutInterval = 20;
  [request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
  NSMutableDictionary *pairBody = [@{
    @"deviceName" : UIDevice.currentDevice.name ?: @"iPhone",
    @"platform" : @"ios",
    @"clientDeviceId" : RBClientDeviceId()
  } mutableCopy];
  NSString *bundleId = NSBundle.mainBundle.bundleIdentifier;
  if (bundleId.length)
    pairBody[@"bundleId"] = bundleId;
  if (passwordMode)
    pairBody[@"password"] = key;
  else
    pairBody[@"pairingKey"] = key;
  request.HTTPBody = [NSJSONSerialization dataWithJSONObject:pairBody options:0 error:nil];
  [self.pairSession invalidateAndCancel];
  NSURLSessionConfiguration *sessionConfig =
      NSURLSessionConfiguration.ephemeralSessionConfiguration;
  NSURLSession *session = [NSURLSession sessionWithConfiguration:sessionConfig
                                                        delegate:self
                                                   delegateQueue:nil];
  self.pairSession = session;
  __weak typeof(self) weak = self;
  [[session dataTaskWithRequest:request
              completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
                NSDictionary *result =
                    data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
                NSInteger status = [response isKindOfClass:NSHTTPURLResponse.class]
                                       ? ((NSHTTPURLResponse *)response).statusCode
                                       : 0;
                dispatch_async(dispatch_get_main_queue(), ^{
                  typeof(self) strong = weak;
                  if (strong && strong.pairSession == session)
                    strong.pairSession = nil;
                  if (!strong || strong.cancelled)
                    return;
                  if (error) {
                    [strong fail:RBL(@"无法连接 Host。", @"Could not connect to Host.")];
                    return;
                  }
                  if (status != 200 && status != 201) {
                    NSString *serverError =
                        ([result isKindOfClass:NSDictionary.class] &&
                         [result[@"error"] isKindOfClass:NSString.class] &&
                         [result[@"error"] length])
                            ? result[@"error"]
                            : nil;
                    if (serverError) {
                      [strong fail:serverError];
                    } else if (status == 401) {
                      [strong fail:passwordMode
                                       ? RBL(@"管理员密码不正确。", @"Admin password is incorrect.")
                                       : RBL(@"配对码无效或已过期。", @"Pairing code is invalid or expired.")];
                    } else if (status == 403) {
                      [strong fail:RBL(@"当前设备无权配对。", @"Pairing was denied by Host.")];
                    } else if (status == 409) {
                      [strong fail:RBL(@"Host 尚未完成初始化设置。", @"Host is not initialized yet.")];
                    } else if (status == 429) {
                      [strong fail:RBL(@"尝试次数过多，请稍后重试。", @"Too many attempts. Try again later.")];
                    } else {
                      [strong fail:RBL(@"配对失败，请重试。", @"Pairing failed. Try again.")];
                    }
                    return;
                  }
                  if (![result isKindOfClass:NSDictionary.class]) {
                    [strong fail:RBL(@"Host 返回无效配置。", @"Host returned an invalid configuration.")];
                    return;
                  }
                  NSString *token = RBConnAsString(result[@"token"]);
                  NSString *gatewayStr = RBConnAsString(result[@"gatewayUrl"]) ?: @"";
                  NSURLComponents *gateway =
                      [NSURLComponents componentsWithString:gatewayStr];
                  if (!token.length || (!strong.tailcat.on && ![gateway.URL.absoluteString isEqual:base])) {
                    [strong fail:RBL(@"Host 配置不匹配。", @"Host configuration does not match.")];
                    return;
                  }
                  NSError *bundleError = nil;
                  NSURL *bundle = [RBHermes writeGateway:base
                                                   token:token
                                               resources:RBConnection.shared.resourcesURL
                                                   error:&bundleError];
                  if (!bundle) {
                    [strong fail:bundleError.localizedDescription ?: RBL(@"无法加载连接模块。", @"Could not load the connection module.")];
                    return;
                  }
                  if (!RBWriteToken(token) || !RBNetworkCommit()) {
                    [strong fail:RBL(@"无法保存设备凭证。", @"Could not save the device credential.")];
                    return;
                  }
                  [NSUserDefaults.standardUserDefaults setObject:RBNetworkAddress() forKey:RBURLKey];
                  [NSUserDefaults.standardUserDefaults setObject:RBConnAsString(result[@"deviceId"]) ?: @""
                                                          forKey:@"RokBotLocal.deviceId"];
                  RBConnection.shared.serverURL = base;
                  RBConnection.shared.deviceToken = token;
                  RBRestoreProfileCache();
                  RBConnection.shared.gatewayBundleURL = bundle;
                  RBSyncAppIntentCredentials();
                  strong.key.text = @"";
                  [strong finishPairing:^{
                                               RBReloadReactHost();
                                               if (RBConnection.shared.didConnect)
                                                 RBConnection.shared.didConnect();
                                             }];
                });
                [session finishTasksAndInvalidate];
              }] resume];
}
@end
