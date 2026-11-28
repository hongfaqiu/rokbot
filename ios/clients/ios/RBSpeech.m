#import "RBSpeech.h"
#import "RBConnection.h"
#import "RBHTTP.h"
#import "RBDiagnostics.h"
#import "RBLocalize.h"

@interface RBSpeechProtocol : NSURLProtocol
@property(nonatomic,strong) NSURLSessionDataTask *task;
@property(atomic,assign) BOOL cancelled;
@end

@implementation RBSpeechProtocol
static NSString *const RBTranscribePath = @"/aiserver.v1.AiService/TranscribeAudio";
// Voice-memo playback: { text, voiceId } -> { audio: base64, mimeType }, answered by the Host.
static NSString *const RBTextToSpeechPath = @"/aiserver.v1.AiService/TextToSpeech";

+ (BOOL)canInitWithRequest:(NSURLRequest *)request {
  return [request.HTTPMethod isEqual:@"POST"] &&
    ([request.URL.path isEqual:RBTranscribePath] || [request.URL.path isEqual:RBTextToSpeechPath]);
}
+ (NSURLRequest *)canonicalRequestForRequest:(NSURLRequest *)request { return request; }
- (void)fail:(NSString *)message code:(NSInteger)code {
  NSError *error = [NSError errorWithDomain:@"RokBotSpeech" code:code userInfo:@{NSLocalizedDescriptionKey:message}];
  [self.client URLProtocol:self didFailWithError:error];
}
- (void)startLoading {
  RBConnection *connection = RBConnection.shared;
  NSString *serverURL = connection.serverURL;
  NSString *deviceToken = connection.deviceToken;
  if (!deviceToken.length || !serverURL.length) {
    [self fail:RBL(@"请先连接 Host。", @"Connect to Host first.") code:401]; return;
  }
  BOOL speech = [self.request.URL.path isEqual:RBTextToSpeechPath];
  NSUInteger limit = speech ? 64 * 1024 : 36 * 1024 * 1024;
  NSData *body = self.request.HTTPBody;
  if (!body && self.request.HTTPBodyStream) {
    NSInputStream *stream = self.request.HTTPBodyStream;
    NSMutableData *collected = [NSMutableData data];
    uint8_t buffer[16384]; NSInteger count;
    [stream open];
    while ((count = [stream read:buffer maxLength:sizeof(buffer)]) > 0) {
      if (collected.length + count > limit) {
        [stream close];
        [self fail:speech ? RBL(@"消息过长，无法朗读。", @"The message is too long to read aloud.")
                          : RBL(@"录音文件过大。", @"The recording is too large.") code:413]; return;
      }
      [collected appendBytes:buffer length:count];
    }
    [stream close];
    if (count < 0) { [self fail:RBL(@"无法读取录音。", @"Could not read the recording.") code:400]; return; }
    body = collected;
  }
  if (body.length > limit) { [self fail:RBL(@"请求过大。", @"The request is too large.") code:413]; return; }
  id parsed = body ? [NSJSONSerialization JSONObjectWithData:body options:0 error:nil] : nil;
  NSMutableDictionary *payload = [parsed isKindOfClass:NSDictionary.class] ? [NSMutableDictionary dictionaryWithDictionary:parsed] : nil;
  if (speech) {
    if (![payload[@"text"] isKindOfClass:NSString.class]) {
      [self fail:RBL(@"无法朗读这条消息。", @"Could not read this message aloud.") code:400]; return;
    }
  } else {
    if (![payload[@"audio"] isKindOfClass:NSString.class]) {
      [self fail:RBL(@"无法读取录音。", @"Could not read the recording.") code:400]; return;
    }
    payload[@"audioBase64"] = payload[@"audio"]; [payload removeObjectForKey:@"audio"];
  }
  NSString *hostPath = speech ? @"/local/audio/speech" : @"/local/audio/transcriptions";
  NSURL *targetURL = [NSURL URLWithString:[serverURL stringByAppendingString:hostPath]];
  if (!targetURL) {
    [self fail:RBL(@"无法连接 Host。", @"Could not connect to Host.") code:400]; return;
  }
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:targetURL];
  request.HTTPMethod = @"POST";
  request.allHTTPHeaderFields = @{@"Content-Type":@"application/json", @"Accept":@"application/json",
    @"Authorization":[@"Bearer " stringByAppendingString:deviceToken]};
  request.timeoutInterval = 125;
  request.HTTPBody = [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil];
  if (speech) RBDiagnosticsEvent(@"speech.synthesis.request", @{@"bytes":@(body.length)});
  else RBDiagnosticsEvent(@"speech.request", @{@"mimeType":payload[@"mimeType"] ?: @"", @"bytes":@(body.length)});
  self.task = [RBHTTPSession() dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
    if (self.cancelled) return;
    if (error) { [self.client URLProtocol:self didFailWithError:error]; return; }
    if (![response isKindOfClass:NSHTTPURLResponse.class]) {
      [self.client URLProtocol:self didFailWithError:[NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorBadServerResponse userInfo:nil]];
      return;
    }
    NSHTTPURLResponse *http = (NSHTTPURLResponse *)response;
    RBDiagnosticsEvent(@"speech.response", @{@"status":@(http.statusCode)});
    NSHTTPURLResponse *original = [[NSHTTPURLResponse alloc] initWithURL:self.request.URL
      statusCode:http.statusCode HTTPVersion:@"HTTP/1.1" headerFields:http.allHeaderFields];
    [self.client URLProtocol:self didReceiveResponse:original cacheStoragePolicy:NSURLCacheStorageNotAllowed];
    if (data.length) [self.client URLProtocol:self didLoadData:data];
    [self.client URLProtocolDidFinishLoading:self];
  }];
  [self.task resume];
}
- (void)stopLoading { self.cancelled = YES; [self.task cancel]; }
@end
Class RBSpeechProtocolClass(void) { return RBSpeechProtocol.class; }
