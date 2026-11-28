#import "RBComputers.h"
#import "RBAvatarStyle.h"
#import "RBConnection.h"
#import "RBAppIntents.h"
#import "RBLibrary.h"
#import "RBNotifications.h"
#import "RBProfile.h"
#import "RBPush.h"
#import "RBConnectors.h"
#import "RBDeepLinks.h"
#import "RBDiagnostics.h"
#import "RBGroupCreate.h"
#import "RBLocalize.h"
#import "RBModels.h"
#import "RBSuggestions.h"
#import "RBUpdater.h"
#import "RBUsage.h"
#import "RBNetwork.h"
#import <dlfcn.h>
#import <objc/message.h>
#import <objc/runtime.h>

static IMP RBOriginalLoad;
static __weak id RBHost;
static BOOL RBLoadedPairedBundle;
static UIWindow *RBWindow(void) {
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes)
    if ([scene isKindOfClass:UIWindowScene.class])
      for (UIWindow *window in ((UIWindowScene *)scene).windows)
        if (window.isKeyWindow)
          return window;
  return nil;
}
static id RBIvar(id object, const char *name) {
  if (!object)
    return nil;
  Ivar ivar = class_getInstanceVariable(object_getClass(object), name);
  return ivar ? object_getIvar(object, ivar) : nil;
}
static id RBFindHost(void) {
  id delegate = UIApplication.sharedApplication.delegate;
  return RBIvar(RBIvar(RBIvar(delegate, "reactNativeFactory"), "_rootViewFactory"), "_reactHost");
}
static void RBLoad(id self, SEL cmd, NSURL *url, id progress, id completion) {
  RBHost = self;
  NSString *embedFlag = NSProcessInfo.processInfo.environment[@"ROKBOT_VALIDATE_EMBEDDED_BUNDLE"]
      ?: NSProcessInfo.processInfo.environment[@"GROKBOT_VALIDATE_EMBEDDED_BUNDLE"];
  BOOL useEmbeddedBundle = [embedFlag boolValue];
  NSURL *paired = RBConnection.shared.gatewayBundleURL;
  NSURL *loaded = useEmbeddedBundle ? url : (paired ?: url);
  RBLoadedPairedBundle = paired != nil && !useEmbeddedBundle;
  RBDiagnosticsRecordBundle(url, loaded);
  RBDiagnosticsEvent(@"bundle.mode", @{@"embedded":@(useEmbeddedBundle), @"paired":@(paired != nil)});
  ((void (*)(id, SEL, NSURL *, id, id))RBOriginalLoad)(self, cmd, loaded, progress,
                                                       completion);
}
void RBReloadReactHost(void) {
  dispatch_async(dispatch_get_main_queue(), ^{
    RBDiagnosticsEvent(@"react.reload", @{});
    id host = RBHost ?: RBFindHost();
    SEL reload = sel_registerName("didReceiveReloadCommand");
    if ([host respondsToSelector:reload])
      ((void (*)(id, SEL))objc_msgSend)(host, reload);
  });
}
static NSSet<NSString *> *RBPrimaryLoginLabels(void) {
  static NSSet<NSString *> *set;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    set = [NSSet setWithArray:@[
      @"Sign in with Apple", @"通过 Apple 登录", @"透過 Apple 登入",
      @"Log in", @"Login", @"Sign in", @"登录", @"登入", @"登陆",
      @"登录或注册", @"Log in or sign up",
      @"连接服务端", @"Connect to Host"
    ]];
  });
  return set;
}
static NSSet<NSString *> *RBSecondaryLoginLabels(void) {
  static NSSet<NSString *> *set;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    set = [NSSet setWithArray:@[
      @"Continue with Google", @"用 Google 账号继续", @"使用 Google 繼續",
      @"Continue with X", @"用 X 账号继续", @"使用 X 繼續",
      @"Continue with email", @"用邮箱继续", @"使用電子郵件繼續",
      @"Continue with phone", @"用手机号继续", @"使用電話號碼繼續",
      @"Sign in with work account", @"Sign in with your work account",
      @"Sign in with SuperGrok", @"使用 SuperGrok 登录", @"使用 SuperGrok 登入",
      @"Sign in to Grok Bot", @"Sign in to RokBot"
    ]];
  });
  return set;
}
static NSSet<NSString *> *RBSignOutLabels(void) {
  static NSSet<NSString *> *set;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    set = [NSSet setWithArray:@[
      @"Sign out", @"Log out", @"退出登录", @"登出", @"退出登入", @"退出账号", @"退出账户"
    ]];
  });
  return set;
}
static NSSet<NSString *> *RBUsageLabels(void) {
  static NSSet<NSString *> *set;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ set = [NSSet setWithArray:@[@"用量", @"Usage"]]; });
  return set;
}
static NSSet<NSString *> *RBDebugLabels(void) {
  static NSSet<NSString *> *set;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ set = [NSSet setWithArray:@[@"调试", @"Debug"]]; });
  return set;
}
static NSSet<NSString *> *RBLibraryLabels(void) {
  static NSSet<NSString *> *set;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ set = [NSSet setWithArray:@[@"资料库", @"Library"]]; });
  return set;
}
static NSSet<NSString *> *RBComputerLabels(void) {
  static NSSet<NSString *> *set;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ set = [NSSet setWithArray:@[@"Bot 电脑", @"Bot Computer"]]; });
  return set;
}
static NSSet<NSString *> *RBToolbarHostLabels(void) {
  static NSSet<NSString *> *set;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    set = [NSSet setWithArray:@[@"调试", @"Debug", @"link", @"连接 Host", @"Host Connection"]];
  });
  return set;
}
static NSSet<NSString *> *RBTouchHostLabels(void) {
  static NSSet<NSString *> *set;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ set = [NSSet setWithArray:@[@"连接服务端", @"Connect to Host"]]; });
  return set;
}
static Class RBFabricViewClass(void) {
  static Class cls;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ cls = NSClassFromString(@"RCTViewComponentView"); });
  return cls;
}
static Class RBSwitchViewClass(void) {
  static Class cls;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ cls = NSClassFromString(@"RCTSwitchComponentView"); });
  return cls;
}
static Class RBScrollViewClass(void) {
  static Class cls;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ cls = NSClassFromString(@"RCTScrollViewComponentView"); });
  return cls;
}
static Class RBImageViewClass(void) {
  static Class cls;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ cls = NSClassFromString(@"RCTImageComponentView"); });
  return cls;
}
static NSHashTable<UIView *> *RBModifiedViews(void) {
  static NSHashTable<UIView *> *table;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    table = [[NSHashTable alloc] initWithOptions:NSHashTableWeakMemory | NSHashTableObjectPointerPersonality
                                        capacity:16];
  });
  return table;
}
void RBTrackModifiedView(UIView *view) {
  if (!view) return;
  [RBModifiedViews() addObject:view];
}
static BOOL RBIsTrackedModifiedView(UIView *view) {
  NSHashTable<UIView *> *table = RBModifiedViews();
  return view != nil && table.count > 0 && [table containsObject:view];
}
static void RBUntrackModifiedView(UIView *view) {
  if (!view) return;
  [RBModifiedViews() removeObject:view];
}
static NSSet<NSString *> *RBAllInterestingLabels(void) {
  static NSSet<NSString *> *set;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    NSMutableSet<NSString *> *all = [NSMutableSet setWithCapacity:64];
    [all unionSet:RBPrimaryLoginLabels()];
    [all unionSet:RBSecondaryLoginLabels()];
    [all unionSet:RBSignOutLabels()];
    [all unionSet:RBUsageLabels()];
    [all unionSet:RBDebugLabels()];
    [all unionSet:RBLibraryLabels()];
    [all unionSet:RBComputerLabels()];
    [all unionSet:RBToolbarHostLabels()];
    [all addObject:@"dev-gateway@localhost"];
    [all addObject:@"dev-gateway@localhost avatar"];
    [all addObject:@"账户"];
    [all addObject:@"语言"];
    [all addObject:@"語言"];
    [all addObject:@"Account"];
    [all addObject:@"Language"];
    // React Native "+" new-chat control (opens the RokBot New Bot / New Group chooser).
    [all addObjectsFromArray:@[@"新建对话", @"新增聊天", @"新建聊天", @"New chat", @"New Chat", @"新建 Bot", @"New Bot"]];
    set = [all copy];
  });
  return set;
}
static NSString *RBTrimWhitespaceIfNeeded(NSString *raw) {
  NSUInteger len = raw.length;
  if (!len) return raw;
  unichar first = [raw characterAtIndex:0];
  unichar last = [raw characterAtIndex:len - 1];
  if (first > 0x20 && last > 0x20 && first < 0x7f && last < 0x7f)
    return raw;
  NSCharacterSet *ws = NSCharacterSet.whitespaceAndNewlineCharacterSet;
  if (![ws characterIsMember:first] && ![ws characterIsMember:last])
    return raw;
  return [raw stringByTrimmingCharactersInSet:ws];
}
static BOOL RBCaptureEnabled(void) {
  static BOOL enabled;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    enabled = getenv("ROKBOT_VALIDATE_CAPTURE") != NULL ||
              getenv("GROKBOT_VALIDATE_CAPTURE") != NULL;
  });
  return enabled;
}
static BOOL RBIsPluginTag(NSInteger tag) {
  return tag >= 731988 && tag <= 731999;
}
static NSString *RBStripPluginLabelSuffixAtDepth(NSString *label, UIView *view, NSUInteger depth) {
  if (!label.length || !view || depth > 8) return label;
  NSString *result = label;
  for (UIView *child in view.subviews.reverseObjectEnumerator) {
    if (RBIsPluginTag(child.tag)) {
      NSString *candidates[2] = {
        child.accessibilityLabel,
        [child isKindOfClass:UIButton.class] ? [((UIButton *)child) titleForState:UIControlStateNormal] : nil
      };
      for (int i = 0; i < 2; i++) {
        NSString *childLabel = RBTrimWhitespaceIfNeeded(candidates[i]);
        if (!childLabel.length) continue;
        NSString *suffix = [@", " stringByAppendingString:childLabel];
        if (result.length > suffix.length && [result hasSuffix:suffix]) {
          result = RBTrimWhitespaceIfNeeded([result substringToIndex:result.length - suffix.length]);
          break;
        }
      }
      continue;
    }
    if (depth < 8 && child.subviews.count > 0)
      result = RBStripPluginLabelSuffixAtDepth(result, child, depth + 1);
  }
  return result;
}
static NSString *RBStripPluginLabelSuffix(NSString *label, UIView *view) {
  return RBStripPluginLabelSuffixAtDepth(label, view, 0);
}
static void RBClearHostSettingsIdentifier(UIView *view) {
  if ([view.accessibilityIdentifier isEqualToString:@"rokbot.host.settings"])
    view.accessibilityIdentifier = nil;
}
BOOL RBHasAncestorPluginTag(UIView *view, NSInteger tag) {
  for (UIView *v = view.superview; v; v = v.superview) {
    if (v.tag == tag) return YES;
    for (UIView *sub in v.subviews)
      if (sub.tag == tag) return YES;
  }
  return NO;
}
static void RBRemoveDescendantPluginTagAtDepth(UIView *view, NSInteger tag, NSUInteger depth) {
  if (!view || depth > 8) return;
  for (UIView *child in [view.subviews copy]) {
    if (child.tag == tag) continue;
    NSMutableArray<UIView *> *stale = nil;
    for (UIView *sub in child.subviews) {
      if (sub.tag == tag) {
        if (!stale) stale = [NSMutableArray array];
        [stale addObject:sub];
      }
    }
    for (UIView *sub in stale) {
      if (tag == 731991) RBClearHostSettingsIdentifier(child);
      else if (tag == 731993) RBResetProfileView(child);
      [sub removeFromSuperview];
    }
    if (stale.count) {
      BOOL stillModified = [child.accessibilityIdentifier isEqualToString:@"rokbot.host.settings"];
      if (!stillModified) {
        for (UIView *rem in child.subviews) {
          if (RBIsPluginTag(rem.tag)) {
            stillModified = YES;
            break;
          }
        }
      }
      if (!stillModified) RBUntrackModifiedView(child);
    }
    RBRemoveDescendantPluginTagAtDepth(child, tag, depth + 1);
  }
}
void RBRemoveDescendantPluginTag(UIView *view, NSInteger tag) {
  RBRemoveDescendantPluginTagAtDepth(view, tag, 0);
}
static BOOL RBSubtreeHasStyledHostButton(UIView *root, UIView *excluding) {
  if (!root || root == excluding || root.hidden || root.alpha < 0.01) return NO;
  if (root.tag == 731991 && [root isKindOfClass:UIButton.class]) {
    UIButton *btn = (UIButton *)root;
    if (btn.configuration != nil) return YES;
  }
  for (UIView *child in root.subviews) {
    if (RBSubtreeHasStyledHostButton(child, excluding)) return YES;
  }
  return NO;
}
static NSSet<NSString *> *RBSettingsContextLabels(void) {
  static NSSet<NSString *> *set;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    set = [NSSet setWithArray:@[
      @"dev-gateway@localhost",
      @"Auto-review", @"自动审查", @"自動審查",
      @"Appearance", @"外观", @"外觀",
      @"Language", @"语言", @"語言",
      @"Usage", @"用量",
      @"Bot 电脑", @"Bot Computer"
    ]];
  });
  return set;
}
static BOOL RBSubtreeContainsSettingsMarker(UIView *root, NSSet<NSString *> *markers, NSUInteger depth) {
  if (!root || root.hidden || root.alpha < 0.01 || depth > 24) return NO;
  if ((root.tag == 731993 && [root isKindOfClass:UIButton.class]) ||
      root.tag == 731989 || root.tag == 731999)
    return YES;
  NSString *raw = nil;
  if ([root isKindOfClass:UILabel.class]) {
    raw = ((UILabel *)root).text;
  } else if (root.bounds.size.height <= 240.0 && root.subviews.count <= 12) {
    raw = root.accessibilityLabel;
  }
  if (raw.length && raw.length <= 64) {
    NSString *trimmed = RBTrimWhitespaceIfNeeded(raw);
    if ([markers containsObject:trimmed]) return YES;
  }
  for (UIView *child in root.subviews) {
    if (RBSubtreeContainsSettingsMarker(child, markers, depth + 1)) return YES;
  }
  return NO;
}
static char RBSettingsContextCacheKey;
static char RBSettingsRescanPendingKey;
static uint64_t RBSettingsContextEpoch = 1;
static void RBInvalidateSettingsContextCache(void) {
  RBSettingsContextEpoch++;
}
static UIViewController *RBEnclosingViewController(UIView *view) {
  for (UIResponder *responder = view.nextResponder; responder; responder = responder.nextResponder) {
    if ([responder isKindOfClass:UIViewController.class])
      return (UIViewController *)responder;
  }
  return nil;
}
static BOOL RBSettingsContextCacheLookup(UIViewController *controller, BOOL *matchedOut, uint64_t *epochOut) {
  if (!controller) return NO;
  NSNumber *cached = objc_getAssociatedObject(controller, &RBSettingsContextCacheKey);
  if (!cached) return NO;
  uint64_t packed = cached.unsignedLongLongValue;
  if (matchedOut) *matchedOut = (packed & 1ULL) != 0;
  if (epochOut) *epochOut = packed >> 1;
  return YES;
}
RBSettingsContextState RBGlobalSettingsContextState(UIView *view) {
  // Scope global Settings interceptions (Sign out, global Push switch) to the
  // enclosing App Settings screen so similarly labeled controls in Bot Settings
  // or Connected Apps sub-screens cannot be hijacked. Cache both YES and NO per
  // view controller by refresh epoch so recycled controllers re-evaluate, and
  // preserve existing overlays when a view temporarily leaves the window.
  UIViewController *controller = RBEnclosingViewController(view);
  BOOL cachedMatched = NO;
  uint64_t cachedEpoch = 0;
  BOOL hasCached = RBSettingsContextCacheLookup(controller, &cachedMatched, &cachedEpoch);
  if (!view.window) {
    if (hasCached && cachedEpoch == RBSettingsContextEpoch)
      return cachedMatched ? RBSettingsContextYes : RBSettingsContextNo;
    return RBSettingsContextUnknown;
  }
  if (!controller || !controller.isViewLoaded) return RBSettingsContextNo;
  if (hasCached && cachedEpoch == RBSettingsContextEpoch)
    return cachedMatched ? RBSettingsContextYes : RBSettingsContextNo;
  BOOL matched = RBSubtreeContainsSettingsMarker(controller.view, RBSettingsContextLabels(), 0);
  uint64_t packed = (RBSettingsContextEpoch << 1) | (matched ? 1ULL : 0ULL);
  objc_setAssociatedObject(controller, &RBSettingsContextCacheKey, @(packed), OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  return matched ? RBSettingsContextYes : RBSettingsContextNo;
}
BOOL RBIsGlobalSettingsContext(UIView *view) {
  return RBGlobalSettingsContextState(view) == RBSettingsContextYes;
}
static RBSettingsContextState RBIsSettingsSignOutContext(UIView *view) {
  return RBGlobalSettingsContextState(view);
}
@interface RBInterface : NSObject
+ (void)showConnection;
+ (void)confirmSignOut;
+ (void)replaceLogin:(UIView *)view;
+ (void)refresh;
@end
static void RBNoteSettingsMarkerOnView(UIView *view) {
  if (!view || view.hidden || view.alpha < 0.01 || !view.window) return;
  UIViewController *controller = RBEnclosingViewController(view);
  if (!controller || !controller.isViewLoaded) return;
  BOOL cachedMatched = NO;
  uint64_t cachedEpoch = 0;
  BOOL hasCached = RBSettingsContextCacheLookup(controller, &cachedMatched, &cachedEpoch);
  if (hasCached && cachedMatched && cachedEpoch == RBSettingsContextEpoch)
    return;
  uint64_t packed = (RBSettingsContextEpoch << 1) | 1ULL;
  objc_setAssociatedObject(controller, &RBSettingsContextCacheKey, @(packed), OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  if (hasCached && !cachedMatched) {
    // A switch or sign-out row laid out before this Settings marker mounted;
    // schedule one coalesced pass on this controller instead of waiting for refresh.
    if ([objc_getAssociatedObject(controller, &RBSettingsRescanPendingKey) boolValue]) return;
    objc_setAssociatedObject(controller, &RBSettingsRescanPendingKey, @YES, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    __weak UIViewController *weakController = controller;
    dispatch_async(dispatch_get_main_queue(), ^{
      UIViewController *strongController = weakController;
      if (!strongController) return;
      objc_setAssociatedObject(strongController, &RBSettingsRescanPendingKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
      if (strongController.isViewLoaded && strongController.view.window)
        [RBInterface replaceLogin:strongController.view];
    });
  }
}
@implementation RBInterface
+ (void)showLibrary {
  RBShowLibrary();
}
+ (void)showComputers {
  RBShowComputers();
}
+ (void)showConnection {
  [RBConnection.shared show];
}
+ (void)confirmSignOut {
  UIViewController *top = RBTopController();
  if (!top) {
    [RBConnection.shared disconnect];
    return;
  }
  if ([top isKindOfClass:UIAlertController.class])
    return;
  UIAlertController *alert = [UIAlertController
      alertControllerWithTitle:RBL(@"退出登录？", @"Sign out?")
                       message:RBL(@"将清除本机的 Host 地址与配对凭证，重新打开后需要重新连接 Host。",
                                   @"This clears the saved Host address and pairing credential from this device.")
                preferredStyle:UIAlertControllerStyleAlert];
  [alert addAction:[UIAlertAction actionWithTitle:RBL(@"取消", @"Cancel")
                                            style:UIAlertActionStyleCancel
                                          handler:nil]];
  [alert addAction:[UIAlertAction actionWithTitle:RBL(@"退出登录", @"Sign out")
                                            style:UIAlertActionStyleDestructive
                                          handler:^(UIAlertAction *action) {
                                            [RBConnection.shared disconnect];
                                          }]];
  [top presentViewController:alert animated:YES completion:nil];
}
+ (void)installHostButtonOn:(UIView *)view styled:(BOOL)styled {
  UIButton *existing = (UIButton *)[view viewWithTag:731991];
  if (existing) {
    if (!CGRectEqualToRect(existing.frame, view.bounds)) {
      existing.frame = view.bounds;
      if (existing.configuration != nil) {
        CGFloat radius = MIN(view.bounds.size.height / 2.0, 26.0);
        if (existing.layer.cornerRadius != radius) existing.layer.cornerRadius = radius;
      }
    }
    return;
  }
  UIButton *button = [UIButton buttonWithType:styled ? UIButtonTypeSystem : UIButtonTypeCustom];
  button.tag = 731991;
  button.frame = view.bounds;
  button.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
  button.accessibilityIdentifier = @"rokbot.host.settings";
  button.accessibilityLabel = RBL(@"连接 Host", @"Connect to Host");
  if (styled) {
    UIButtonConfiguration *config = UIButtonConfiguration.filledButtonConfiguration;
    config.title = RBL(@"连接 Host", @"Connect to Host");
    config.image = [UIImage systemImageNamed:@"link"];
    config.imagePadding = 8;
    config.cornerStyle = UIButtonConfigurationCornerStyleCapsule;
    config.baseBackgroundColor = UIColor.labelColor;
    config.baseForegroundColor = UIColor.systemBackgroundColor;
    button.configuration = config;
    button.layer.cornerRadius = MIN(view.bounds.size.height / 2.0, 26.0);
    button.clipsToBounds = YES;
  }
  [button addTarget:self
                action:@selector(showConnection)
      forControlEvents:UIControlEventTouchUpInside];
  if (!view.userInteractionEnabled) view.userInteractionEnabled = YES;
  [view addSubview:button];
  RBTrackModifiedView(view);
}
+ (void)replaceEntry:(UIView *)view {
  if (RBIsPluginTag(view.tag))
    return;
  if ([view isKindOfClass:UISwitch.class]) {
    RBReplacePushView(view);
    return;
  }
  BOOL tracked = RBIsTrackedModifiedView(view);
  CGRect bounds = view.bounds;
  NSArray<UIView *> *subviews = view.subviews;
  NSUInteger childCount = subviews.count;
  // Fast push-switch check before touching accessibilityLabel (which is recursive on Fabric views).
  if (childCount > 0 && childCount <= 4) {
    for (UIView *child in subviews) {
      if ([child isKindOfClass:UISwitch.class]) {
        if (RBReplacePushView(view))
          return;
        break;
      }
    }
  }
  // Never invoke Fabric's recursive accessibilityLabel on zero-size/hairline views
  // or large list/scroll/screen containers (e.g. a Bot roster with dozens of rows).
  if (bounds.size.width < 8.0 || bounds.size.height < 8.0 ||
      bounds.size.height > 240.0 || childCount > 12) {
    if (tracked && (bounds.size.height > 240.0 || childCount > 12)) {
      if (view.accessibilityIdentifier != nil) RBClearHostSettingsIdentifier(view);
      NSMutableArray<UIView *> *stale = nil;
      for (UIView *child in subviews) {
        NSInteger tag = child.tag;
        if (RBIsPluginTag(tag) && tag != 731990) {
          if (!stale) stale = [NSMutableArray array];
          [stale addObject:child];
        }
      }
      for (UIView *child in stale) {
        if (child.tag == 731991) RBClearHostSettingsIdentifier(view);
        else if (child.tag == 731993) RBResetProfileView(view);
        [child removeFromSuperview];
      }
    }
    return;
  }
  BOOL hasPluginChild = NO;
  if (tracked) {
    for (UIView *child in subviews) {
      if (RBIsPluginTag(child.tag)) {
        hasPluginChild = YES;
        break;
      }
    }
  }
  NSString *rawLabel = nil;
  if ([view isKindOfClass:UIButton.class])
    rawLabel = [((UIButton *)view) titleForState:UIControlStateNormal];
  else if ([view isKindOfClass:UILabel.class])
    rawLabel = ((UILabel *)view).text;
  else
    rawLabel = view.accessibilityLabel;
  if (!hasPluginChild) {
    if (rawLabel.length == 0 || rawLabel.length > 80) {
      if (tracked && view.accessibilityIdentifier != nil) RBClearHostSettingsIdentifier(view);
      return;
    }
    NSString *fastLabel = RBTrimWhitespaceIfNeeded(rawLabel);
    NSSet<NSString *> *interesting = RBAllInterestingLabels();
    if (!fastLabel.length || ![interesting containsObject:fastLabel]) {
      NSString *recovered = nil;
      if (fastLabel.length > 0 && RBModifiedViews().count > 0) {
        NSRange sep = [fastLabel rangeOfString:@", "];
        if (sep.location != NSNotFound && sep.location > 0 && sep.location <= 40) {
          NSString *prefix = RBTrimWhitespaceIfNeeded([fastLabel substringToIndex:sep.location]);
          if ([interesting containsObject:prefix]) {
            NSString *stripped = RBStripPluginLabelSuffix(fastLabel, view);
            if (![stripped isEqualToString:fastLabel] && [interesting containsObject:stripped])
              recovered = stripped;
          }
        }
      }
      if (!recovered) {
        if (tracked && view.accessibilityIdentifier != nil) RBClearHostSettingsIdentifier(view);
        return;
      }
      fastLabel = recovered;
    }
    rawLabel = fastLabel;
  }
  NSString *label = hasPluginChild ? RBTrimWhitespaceIfNeeded(rawLabel) : rawLabel;
  if (hasPluginChild && label.length)
    label = RBStripPluginLabelSuffix(label, view);
  if (!hasPluginChild && !label.length) {
    if (tracked && view.accessibilityIdentifier != nil) RBClearHostSettingsIdentifier(view);
    return;
  }
  RBObserveAppLanguage(label);
  NSSet<NSString *> *primaryLogin = RBPrimaryLoginLabels();
  NSSet<NSString *> *secondaryLogin = RBSecondaryLoginLabels();
  NSSet<NSString *> *signOutLabels = RBSignOutLabels();
  NSSet<NSString *> *usageLabels = RBUsageLabels();
  NSSet<NSString *> *debugLabels = RBDebugLabels();
  NSSet<NSString *> *libraryLabels = RBLibraryLabels();
  NSSet<NSString *> *computerLabels = RBComputerLabels();
  BOOL paired = RBConnection.shared.isPaired;
  BOOL checkedSettingsSignOut = NO;
  RBSettingsContextState settingsSignOutState = RBSettingsContextUnknown;
  if (hasPluginChild) {
    NSMutableArray<UIView *> *stale = nil;
    for (UIView *child in subviews) {
      NSInteger tag = child.tag;
      if (!RBIsPluginTag(tag)) continue;
      BOOL remove = NO;
      if (tag == 731988) {
        if (!paired || ![signOutLabels containsObject:label]) {
          remove = YES;
        } else {
          if (!checkedSettingsSignOut) {
            settingsSignOutState = RBIsSettingsSignOutContext(view);
            checkedSettingsSignOut = YES;
          }
          if (settingsSignOutState == RBSettingsContextNo) remove = YES;
        }
      } else if (tag == 731989 && ![usageLabels containsObject:label]) {
        remove = YES;
      } else if (tag == 731991 &&
                 (paired || (![primaryLogin containsObject:label] && ![secondaryLogin containsObject:label] &&
                             ![debugLabels containsObject:label]))) {
        remove = YES;
      } else if (tag == 731992 && ![libraryLabels containsObject:label]) {
        remove = YES;
      } else if (tag == 731993 && ![label isEqualToString:@"dev-gateway@localhost"] &&
                 ![label isEqualToString:@"dev-gateway@localhost avatar"]) {
        remove = YES;
      } else if (tag == 731999 && ![computerLabels containsObject:label]) {
        remove = YES;
      } else if (tag == 731995 && !RBGroupIsNewChatLabel(label)) {
        remove = YES;
      }
      if (remove) {
        if (!stale) stale = [NSMutableArray array];
        [stale addObject:child];
      }
    }
    for (UIView *child in stale) {
      if (child.tag == 731991) RBClearHostSettingsIdentifier(view);
      else if (child.tag == 731993) RBResetProfileView(view);
      [child removeFromSuperview];
    }
  }
  if ([RBSettingsContextLabels() containsObject:label])
    RBNoteSettingsMarkerOnView(view);
  if ([label hasPrefix:@"dev-gateway@localhost"] && RBReplaceProfileView(view))
    return;
  Class fabricViewClass = RBFabricViewClass();
  BOOL isFabricView = fabricViewClass && [view isKindOfClass:fabricViewClass];
  if (isFabricView && paired && [signOutLabels containsObject:label] &&
      bounds.size.width >= 60 && bounds.size.height >= 36) {
    if (RBHasAncestorPluginTag(view, 731988))
      return;
    if (!checkedSettingsSignOut) {
      settingsSignOutState = RBIsSettingsSignOutContext(view);
      checkedSettingsSignOut = YES;
    }
    if (settingsSignOutState == RBSettingsContextYes) {
      RBRemoveDescendantPluginTag(view, 731988);
      UIButton *existing = (UIButton *)[view viewWithTag:731988];
      if (existing) {
        if (!CGRectEqualToRect(existing.frame, bounds)) existing.frame = bounds;
        NSString *signOutLabel = RBL(@"退出登录", @"Sign out");
        if (![existing.accessibilityLabel isEqualToString:signOutLabel])
          existing.accessibilityLabel = signOutLabel;
      } else {
        UIButton *button = [UIButton buttonWithType:UIButtonTypeCustom];
        button.tag = 731988;
        button.frame = bounds;
        button.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
        button.accessibilityIdentifier = @"rokbot.host.signout";
        button.accessibilityLabel = RBL(@"退出登录", @"Sign out");
        [button addTarget:self
                      action:@selector(confirmSignOut)
            forControlEvents:UIControlEventTouchUpInside];
        if (!view.userInteractionEnabled) view.userInteractionEnabled = YES;
        [view addSubview:button];
        RBTrackModifiedView(view);
      }
      return;
    }
  }
  if (isFabricView && !paired && [primaryLogin containsObject:label] && bounds.size.width >= 160 &&
      bounds.size.height >= 40) {
    if (RBHasAncestorPluginTag(view, 731991))
      return;
    RBRemoveDescendantPluginTag(view, 731991);
    if (![view.accessibilityIdentifier isEqualToString:@"rokbot.host.settings"])
      view.accessibilityIdentifier = @"rokbot.host.settings";
    RBTrackModifiedView(view);
    if ([view viewWithTag:731991]) {
      [self installHostButtonOn:view styled:NO];
    } else {
      BOOL useStyled = !RBSubtreeHasStyledHostButton(view.window, view);
      [self installHostButtonOn:view styled:useStyled];
    }
    return;
  }
  if (isFabricView && !paired && [secondaryLogin containsObject:label] && bounds.size.width >= 160 &&
      bounds.size.height >= 40) {
    if (RBHasAncestorPluginTag(view, 731991))
      return;
    RBRemoveDescendantPluginTag(view, 731991);
    if (![view.accessibilityIdentifier isEqualToString:@"rokbot.host.settings"])
      view.accessibilityIdentifier = @"rokbot.host.settings";
    RBTrackModifiedView(view);
    [self installHostButtonOn:view styled:NO];
    return;
  }
  if (isFabricView && [computerLabels containsObject:label] && bounds.size.width > 300 &&
      bounds.size.height >= 44) {
    if (RBHasAncestorPluginTag(view, 731999))
      return;
    RBRemoveDescendantPluginTag(view, 731999);
    UIButton *existing = (UIButton *)[view viewWithTag:731999];
    if (existing) {
      if (!CGRectEqualToRect(existing.frame, bounds)) existing.frame = bounds;
    } else {
      UIButton *button = [UIButton buttonWithType:UIButtonTypeCustom];
      button.tag = 731999;
      button.frame = bounds;
      button.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
      button.accessibilityLabel = RBL(@"Bot 电脑", @"Bot Computer");
      [button addTarget:self
                    action:@selector(showComputers)
          forControlEvents:UIControlEventTouchUpInside];
      if (!view.userInteractionEnabled) view.userInteractionEnabled = YES;
      [view addSubview:button];
      RBTrackModifiedView(view);
    }
    return;
  }
  if (!paired &&
      [debugLabels containsObject:label] && bounds.size.width > 200 &&
      bounds.size.height >= 40) {
    // Unpaired full-width Debug entry opens local Host setup.
    if (RBHasAncestorPluginTag(view, 731991))
      return;
    RBRemoveDescendantPluginTag(view, 731991);
    if (![view.accessibilityIdentifier isEqualToString:@"rokbot.host.settings"])
      view.accessibilityIdentifier = @"rokbot.host.settings";
    RBTrackModifiedView(view);
    [self installHostButtonOn:view styled:NO];
    return;
  }
  if ([RBToolbarHostLabels() containsObject:label] && paired && bounds.size.width <= 88) {
    // Keep the original toolbar and link icon; only route the original touch.
    NSString *hostLabel = RBL(@"连接 Host", @"Host Connection");
    if (![view.accessibilityLabel isEqualToString:hostLabel])
      view.accessibilityLabel = hostLabel;
    if (![view.accessibilityIdentifier isEqualToString:@"rokbot.host.settings"])
      view.accessibilityIdentifier = @"rokbot.host.settings";
    RBTrackModifiedView(view);
    return;
  }
  if (tracked && view.accessibilityIdentifier != nil)
    RBClearHostSettingsIdentifier(view);
  if (isFabricView && [libraryLabels containsObject:label] && paired &&
      bounds.size.width > 20 && bounds.size.height >= 28) {
    if (RBHasAncestorPluginTag(view, 731992))
      return;
    RBRemoveDescendantPluginTag(view, 731992);
    UIButton *existing = (UIButton *)[view viewWithTag:731992];
    if (existing) {
      if (!CGRectEqualToRect(existing.frame, bounds)) existing.frame = bounds;
      NSString *libraryLabel = RBL(@"资料库", @"Library");
      if (![existing.accessibilityLabel isEqualToString:libraryLabel])
        existing.accessibilityLabel = libraryLabel;
    } else {
      // Transparent touch overlay preserving the original row/pill visuals
      // without drawing a second centered title over the native row text.
      UIButton *button = [UIButton buttonWithType:UIButtonTypeCustom];
      button.tag = 731992;
      button.frame = bounds;
      button.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
      button.accessibilityIdentifier = @"rokbot.library.open";
      button.accessibilityLabel = RBL(@"资料库", @"Library");
      [button addTarget:self
                    action:@selector(showLibrary)
          forControlEvents:UIControlEventTouchUpInside];
      if (!view.userInteractionEnabled) view.userInteractionEnabled = YES;
      [view addSubview:button];
      RBTrackModifiedView(view);
    }
    return;
  }
  if (isFabricView && paired && RBReplaceNewChatView(view, label))
    return;
  if (isFabricView && [usageLabels containsObject:label])
    RBReplaceUsageView(view);
}
+ (void)replaceLogin:(UIView *)view {
  [self replaceEntry:view];
  if (RBIsPluginTag(view.tag)) return;
  for (UIView *child in view.subviews) [self replaceLogin:child];
}
+ (void)refresh {
  UIWindow *window = RBWindow();
  if (!window)
    return;
  RBInvalidateSettingsContextCache();
  [self replaceLogin:window];
}

@end
static IMP RBOriginalTask;
static IMP RBOriginalSimpleTask;
static IMP RBOriginalTouches;
static IMP RBOriginalRecycle;
static IMP RBOriginalLayout;
static IMP RBOriginalActionWithTitle;
static IMP RBOriginalMenuWithChildren;
static IMP RBOriginalMenuElementTitle;
static void RBLocalizeMenuElements(NSArray<UIMenuElement *> *elements) {
  if (!elements.count || !RBIsChinese()) return;
  for (UIMenuElement *element in elements) {
    if ([element isKindOfClass:UIAction.class]) {
      UIAction *action = (UIAction *)element;
      if ([action.title isEqualToString:@"Scan Document"])
        action.title = @"扫描文稿";
    } else if ([element isKindOfClass:UIMenu.class]) {
      RBLocalizeMenuElements(((UIMenu *)element).children);
    }
  }
}
static UIAction *RBActionWithTitle(id self, SEL selector, NSString *title, UIImage *image,
                                   UIActionIdentifier identifier, UIActionHandler handler) {
  if (RBIsChinese() && [title isEqualToString:@"Scan Document"])
    title = @"扫描文稿";
  return ((UIAction *(*)(id, SEL, NSString *, UIImage *, UIActionIdentifier, UIActionHandler))
              RBOriginalActionWithTitle)(self, selector, title, image, identifier, handler);
}
static UIMenu *RBMenuWithChildren(id self, SEL selector, NSString *title, UIImage *image,
                                  UIMenuIdentifier identifier, UIMenuOptions options,
                                  NSArray<UIMenuElement *> *children) {
  RBLocalizeMenuElements(children);
  return ((UIMenu *(*)(id, SEL, NSString *, UIImage *, UIMenuIdentifier, UIMenuOptions,
                       NSArray<UIMenuElement *> *))RBOriginalMenuWithChildren)(
      self, selector, title, image, identifier, options, children);
}
static NSString *RBMenuElementTitle(UIMenuElement *self, SEL selector) {
  NSString *title = ((NSString *(*)(id, SEL))RBOriginalMenuElementTitle)(self, selector);
  if (RBIsChinese() && [title isEqualToString:@"Scan Document"])
    return @"扫描文稿";
  return title;
}
static NSTimer *RBPresenceTimer;
static NSTimer *RBNetworkHealthTimer;
static BOOL RBStartupRefreshed;
static dispatch_queue_t RBAppIntentsVerifyQueue(void) {
  static dispatch_queue_t queue;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    queue = dispatch_queue_create("dev.rokbot.local.app-intents-verify", DISPATCH_QUEUE_SERIAL);
  });
  return queue;
}
static void RBVerifyAppIntentCredentialsAsync(void) {
  dispatch_async(RBAppIntentsVerifyQueue(), ^{
    RBVerifyAppIntentCredentials();
  });
}
static void RBEnsureNetworkReadyAsync(void) {
  if (!RBNetworkEnabled()) return;
  NSString *serverURL = RBConnection.shared.serverURL;
  if (!serverURL.length) return;
  NSURL *url = [NSURL URLWithString:serverURL];
  if (!url) return;
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    RBNetworkEnsureReadyForURL(url);
  });
}
static void RBStopForegroundTimers(void) {
  [RBPresenceTimer invalidate];
  RBPresenceTimer = nil;
  [RBNetworkHealthTimer invalidate];
  RBNetworkHealthTimer = nil;
}
static void RBStartForegroundTimers(void) {
  if (RBConnection.shared.isPaired) {
    if (!RBPresenceTimer) {
      RBPresenceTimer = [NSTimer scheduledTimerWithTimeInterval:25 repeats:YES block:^(NSTimer *timer) {
        if (UIApplication.sharedApplication.applicationState == UIApplicationStateActive &&
            RBConnection.shared.isPaired)
          RBPushSetForeground(YES);
      }];
      RBPresenceTimer.tolerance = 5.0;
    }
  } else if (RBPresenceTimer) {
    [RBPresenceTimer invalidate];
    RBPresenceTimer = nil;
  }
  if (RBNetworkEnabled()) {
    if (!RBNetworkHealthTimer) {
      // Inspect cached transport health only while active. This also recovers a
      // stale peer when the original UI is waiting without making new requests.
      RBNetworkHealthTimer = [NSTimer scheduledTimerWithTimeInterval:5 repeats:YES block:^(NSTimer *timer) {
        if (UIApplication.sharedApplication.applicationState == UIApplicationStateActive)
          RBEnsureNetworkReadyAsync();
      }];
      RBNetworkHealthTimer.tolerance = 1.0;
    }
  } else if (RBNetworkHealthTimer) {
    [RBNetworkHealthTimer invalidate];
    RBNetworkHealthTimer = nil;
  }
}
typedef NS_ENUM(NSInteger, RBLayoutKind) {
  RBLayoutKindSkip = 0,
  RBLayoutKindEntry = 1,
  RBLayoutKindSwitch = 2,
  RBLayoutKindImage = 3,
  RBLayoutKindAvatarSvg = 4,
};
static RBLayoutKind RBLayoutKindForClass(Class cls) {
  static CFMutableDictionaryRef cache;
  static Class scrollClass, paragraphClass, textInputClass, switchClass, imageClass, svgClass;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    cache = CFDictionaryCreateMutable(NULL, 32, NULL, NULL);
    scrollClass = RBScrollViewClass();
    paragraphClass = NSClassFromString(@"RCTParagraphComponentView");
    textInputClass = NSClassFromString(@"RCTTextInputComponentView");
    switchClass = RBSwitchViewClass();
    imageClass = RBImageViewClass();
    svgClass = NSClassFromString(@"RNSVGSvgView");
  });
  const void *key = (__bridge const void *)cls;
  const void *cached = NULL;
  if (CFDictionaryGetValueIfPresent(cache, key, &cached))
    return (RBLayoutKind)(intptr_t)cached;
  RBLayoutKind kind = RBLayoutKindEntry;
  if ((scrollClass && [cls isSubclassOfClass:scrollClass]) ||
      (paragraphClass && [cls isSubclassOfClass:paragraphClass]) ||
      (textInputClass && [cls isSubclassOfClass:textInputClass]) ||
      [cls isSubclassOfClass:UIScrollView.class]) {
    kind = RBLayoutKindSkip;
  } else if (switchClass && [cls isSubclassOfClass:switchClass]) {
    kind = RBLayoutKindSwitch;
  } else if (imageClass && [cls isSubclassOfClass:imageClass]) {
    kind = RBLayoutKindImage;
  } else if (svgClass && [cls isSubclassOfClass:svgClass]) {
    kind = RBLayoutKindAvatarSvg;
  } else if ([NSStringFromClass(cls) hasPrefix:@"RNSVG"]) {
    kind = RBLayoutKindSkip;
  }
  CFDictionarySetValue(cache, key, (const void *)(intptr_t)kind);
  return kind;
}
static void RBLayout(id self, SEL selector) {
  ((void (*)(id, SEL))RBOriginalLayout)(self, selector);
  // Skip known expensive non-target Fabric subclasses (scroll views at 120Hz,
  // text paragraphs, text inputs, RNSVG* child nodes) while handling RNSVGSvgView avatars.
  switch (RBLayoutKindForClass([self class])) {
    case RBLayoutKindSkip:
      break;
    case RBLayoutKindEntry:
      [RBInterface replaceEntry:self];
      break;
    case RBLayoutKindSwitch:
      RBReplacePushView(self);
      break;
    case RBLayoutKindImage:
      if (RBConnection.shared.isPaired)
        RBReplaceProfileView(self);
      break;
    case RBLayoutKindAvatarSvg:
      RBUpdateAvatarView(self);
      break;
  }
}
static void RBRecycle(id self, SEL selector) {
  if (RBIsTrackedModifiedView(self)) {
    RBUntrackModifiedView(self);
    RBResetProfileView(self);
    RBResetPushView(self);
    RBResetAvatarSuperview(self);
    if ([self accessibilityIdentifier] != nil)
      RBClearHostSettingsIdentifier(self);
    NSMutableArray<UIView *> *stale = nil;
    for (UIView *child in [self subviews]) {
      if (RBIsPluginTag(child.tag)) {
        if (!stale) stale = [NSMutableArray array];
        [stale addObject:child];
      }
    }
    for (UIView *child in stale)
      [child removeFromSuperview];
  }
  ((void (*)(id, SEL))RBOriginalRecycle)(self, selector);
}
static void RBTouches(id self, SEL selector, NSSet<UITouch *> *touches, UIEvent *event) {
  // Fabric handles ancestor touches even when a native button receives them.
  // Exclude plugin controls first so native buttons handle TouchUpInside cleanly.
  for (UITouch *touch in touches)
    for (UIView *v = touch.view; v; v = v.superview)
      if (RBIsPluginTag(v.tag))
        return;
  NSSet<NSString *> *touchHostLabels = RBTouchHostLabels();
  BOOL paired = RBConnection.shared.isPaired;
  Class scrollViewClass = RBScrollViewClass();
  for (UITouch *touch in touches)
    for (UIView *v = touch.view; v; v = v.superview) {
      if ([v.accessibilityIdentifier isEqualToString:@"rokbot.host.settings"]) {
        [RBConnection.shared show];
        return;
      }
      // Never trigger Fabric's recursive accessibilityLabel on scroll views,
      // windows, or multi-row containers when a scroll swipe begins.
      if ([v isKindOfClass:UIScrollView.class] || [v isKindOfClass:UIWindow.class] ||
          (scrollViewClass && [v isKindOfClass:scrollViewClass]) ||
          v.bounds.size.height > 160.0 || v.subviews.count > 12)
        continue;
      NSString *lbl = v.accessibilityLabel;
      if (lbl.length > 0 && lbl.length <= 40 &&
          ([touchHostLabels containsObject:lbl] || (paired && [lbl isEqualToString:@"link"]))) {
        [RBConnection.shared show];
        return;
      }
    }
  ((void (*)(id, SEL, id, id))RBOriginalTouches)(self, selector, touches, event);
}
static id RBSimpleTask(id self, SEL selector, NSURLRequest *request) {
  BOOL networkReady = RBNetworkEnsureReadyForURL(request.URL);
  if (RBDiagnosticsEnabled())
    RBDiagnosticsEvent(@"network.request", @{@"host":request.URL.host ?: @"", @"path":request.URL.path ?: @""});
  RBObserveRequest(request);
  id task = ((id (*)(id, SEL, id))RBOriginalSimpleTask)(self, selector, request);
  if (!networkReady) [task cancel];
  else if (RBCaptureEnabled()) RBDiagnosticsObserveTask(task);
  return task;
}
static id RBTask(id self, SEL selector, NSURLRequest *request, id completion) {
  BOOL networkReady = RBNetworkEnsureReadyForURL(request.URL);
  if (RBDiagnosticsEnabled())
    RBDiagnosticsEvent(@"network.request", @{@"host":request.URL.host ?: @"", @"path":request.URL.path ?: @""});
  RBObserveRequest(request);
  if (RBCaptureEnabled() && completion) {
    void (^original)(NSData *, NSURLResponse *, NSError *) = completion;
    completion = ^(NSData *data, NSURLResponse *response, NSError *error) {
      NSInteger status = [response isKindOfClass:NSHTTPURLResponse.class]
          ? ((NSHTTPURLResponse *)response).statusCode : 0;
      RBDiagnosticsEvent(@"network.complete", @{@"path":request.URL.path ?: @"", @"status":@(status), @"error":@(error.code)});
      original(data, response, error);
    };
  }
  id task = ((id (*)(id, SEL, id, id))RBOriginalTask)(self, selector, request, completion);
  if (!networkReady) [task cancel];
  return task;
}
static void RBInstall(void) {
  RBInstallDeepLinks();
  RBInstallSuggestions();
  if (!RBOriginalLayout) {
    Class cls = NSClassFromString(@"RCTViewComponentView");
    Method method = class_getInstanceMethod(cls, @selector(layoutSubviews));
    if (method) {
      RBOriginalLayout = method_getImplementation(method);
      class_replaceMethod(cls, @selector(layoutSubviews), (IMP)RBLayout, method_getTypeEncoding(method));
    }
  }
  if (!RBOriginalRecycle) {
    Method method = class_getInstanceMethod(NSClassFromString(@"RCTViewComponentView"),
                                            sel_registerName("prepareForRecycle"));
    if (method)
      RBOriginalRecycle = method_setImplementation(method, (IMP)RBRecycle);
  }
  if (!RBOriginalTouches) {
    Method method = class_getInstanceMethod(NSClassFromString(@"RCTSurfaceTouchHandler"),
                                            @selector(touchesBegan:withEvent:));
    if (method)
      RBOriginalTouches = method_setImplementation(method, (IMP)RBTouches);
  }
  if (!RBOriginalSimpleTask) {
    Method method =
        class_getInstanceMethod(NSURLSession.class, sel_registerName("dataTaskWithRequest:"));
    if (method)
      RBOriginalSimpleTask = method_setImplementation(method, (IMP)RBSimpleTask);
  }
  if (!RBOriginalTask) {
    Method method = class_getInstanceMethod(
        NSURLSession.class, sel_registerName("dataTaskWithRequest:completionHandler:"));
    if (method)
      RBOriginalTask = method_setImplementation(method, (IMP)RBTask);
  }
  if (!RBOriginalLoad) {
    Method method = class_getInstanceMethod(
        NSClassFromString(@"RCTHost"), sel_registerName("loadBundleAtURL:onProgress:onComplete:"));
    if (method)
      RBOriginalLoad = method_setImplementation(method, (IMP)RBLoad);
  }
  if (!RBOriginalActionWithTitle) {
    Method method = class_getClassMethod(
        UIAction.class, @selector(actionWithTitle:image:identifier:handler:));
    if (method)
      RBOriginalActionWithTitle = method_setImplementation(method, (IMP)RBActionWithTitle);
  }
  if (!RBOriginalMenuWithChildren) {
    Method method = class_getClassMethod(
        UIMenu.class, @selector(menuWithTitle:image:identifier:options:children:));
    if (method)
      RBOriginalMenuWithChildren = method_setImplementation(method, (IMP)RBMenuWithChildren);
  }
  if (!RBOriginalMenuElementTitle) {
    Method method = class_getInstanceMethod(UIMenuElement.class, @selector(title));
    if (method)
      RBOriginalMenuElementTitle = method_setImplementation(method, (IMP)RBMenuElementTitle);
  }
}
// Unpaired devices get a forced, full-screen pairing page. The app window may
// not exist yet at launch / activation / RN content appearance, so retry every
// 0.25s, at most 20 attempts. A newer trigger supersedes a pending retry chain.
static const NSInteger RBRequiredPairingMaxAttempts = 20;
static const int64_t RBRequiredPairingRetryNanoseconds = NSEC_PER_SEC / 4;
static NSUInteger RBRequiredPairingGeneration;
static void RBPresentRequiredPairingAttempt(NSUInteger generation, NSInteger attempt) {
  if (generation != RBRequiredPairingGeneration) return;
  if (RBShowRequiredPairing()) return;
  if (attempt + 1 >= RBRequiredPairingMaxAttempts) {
    RBDiagnosticsEvent(@"pairing.required.unavailable", @{@"attempts":@(attempt + 1)});
    return;
  }
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, RBRequiredPairingRetryNanoseconds), dispatch_get_main_queue(), ^{
    RBPresentRequiredPairingAttempt(generation, attempt + 1);
  });
}
static void RBPresentRequiredPairing(void) {
  dispatch_async(dispatch_get_main_queue(), ^{
    RBPresentRequiredPairingAttempt(++RBRequiredPairingGeneration, 0);
  });
}
__attribute__((constructor)) static void RBInitialize(void) {
  @autoreleasepool {
    RBDiagnosticsEvent(@"bootstrap.begin", @{});
    Dl_info location = {0};
    dladdr((const void *)&RBInitialize, &location);
    NSString *libraryPath =
        location.dli_fname ? [NSString stringWithUTF8String:location.dli_fname] : nil;
    if (!libraryPath.length)
      return;
    RBConnection.shared.resourcesURL =
        [[NSURL fileURLWithPath:libraryPath.stringByDeletingLastPathComponent]
            URLByAppendingPathComponent:@"RokBotLocal.bundle"
                            isDirectory:YES];
    NSError *error = nil;
    BOOL restored = [RBConnection.shared restore:&error];
    RBDiagnosticsEvent(@"connection.restore", @{@"restored":restored ? @YES : @NO});
    RBInstallConnectorTransport();
    RBInstall();
    // Restore before the app creates its first RCTHost. A delayed unconditional
    // reload discards the navigation established by a cold notification click.
    dispatch_async(dispatch_get_main_queue(), ^{
      RBEnsureNetworkReadyAsync();
      RBConnection.shared.didConnect = ^{
        RBSyncAppIntentCredentials();
        [[RBNotifications shared] start];
        BOOL active = UIApplication.sharedApplication.applicationState == UIApplicationStateActive;
        RBPushSetForeground(active);
        if (active) RBStartForegroundTimers();
        RBRefreshProfile();
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), dispatch_get_main_queue(), ^{
          RBPushRefresh();
          RBCheckModelOnboardingIfNeeded();
        });
      };
      RBConnection.shared.didDisconnect = ^{
        [[RBNotifications shared] stop];
        RBStopForegroundTimers();
      };
      NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
      [center addObserverForName:UIApplicationDidBecomeActiveNotification
                          object:nil
                           queue:NSOperationQueue.mainQueue
                      usingBlock:^(NSNotification *n) {
                        RBStartupRefreshed = YES;
                        RBInstall();
                        RBEnsureNetworkReadyAsync();
                        RBVerifyAppIntentCredentialsAsync();
                        [RBInterface refresh];
                        [[RBNotifications shared] start];
                        RBPushSetForeground(YES);
                        RBRefreshProfile();
                        RBPushRefresh();
                        RBCheckUpdatesInBackgroundIfNeeded();
                        RBStartForegroundTimers();
                        RBPresentRequiredPairing();
                      }];
      [center addObserverForName:UIApplicationDidEnterBackgroundNotification
                          object:nil
                           queue:NSOperationQueue.mainQueue
                      usingBlock:^(NSNotification *n) {
                        RBStopForegroundTimers();
                        [[RBNotifications shared] stop];
                        RBPushSetForeground(NO);
                      }];
      for (NSString *name in @[@"RokBotProfileChanged", @"RokBotPushStateChanged", @"RokBotModelConfigChanged", @"RCTContentDidAppearNotification"])
        [center addObserverForName:name object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *n) { [RBInterface refresh]; }];
      [center addObserverForName:@"RCTContentDidAppearNotification" object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *n) {
        RBPresentRequiredPairing();
      }];
      if (UIApplication.sharedApplication.applicationState == UIApplicationStateActive)
        RBStartForegroundTimers();
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        if (restored && RBHost && !RBLoadedPairedBundle) RBReloadReactHost();
        [RBInterface refresh];
        RBPresentRequiredPairing();
        if (!RBStartupRefreshed) {
          RBStartupRefreshed = YES;
          if (restored) {
            [[RBNotifications shared] start];
            RBRefreshProfile();
            RBPushRefresh();
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), dispatch_get_main_queue(), ^{
              RBCheckModelOnboardingIfNeeded();
              RBCheckUpdatesInBackgroundIfNeeded();
            });
          }
        }
      });
    });
  }
}
