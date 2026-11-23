#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Carbon/Carbon.h>
#include <node_api.h>
#include <unistd.h>
#include <atomic>

// AppKit delivers the mouse monitor on the main thread. AX queries can wait on
// another application's UI thread, so perform those on a private serial queue.
static id monitor;
static napi_threadsafe_function callback;
static std::atomic<unsigned long> generation{0};
static dispatch_queue_t queries;
// Accessed on the serial AX queue. A new Chrome process needs its own request.
static NSRunningApplication *preparedChrome;
static NSTimeInterval chromeRequestedAt;
static void emit(NSDictionary *event);

static id attribute(AXUIElementRef element, CFStringRef name) {
    CFTypeRef result = nullptr;
    if (AXUIElementCopyAttributeValue(element, name, &result) != kAXErrorSuccess) return nil;
    return CFBridgingRelease(result);
}

static bool isElement(id value) {
    return value && CFGetTypeID((__bridge CFTypeRef)value) == AXUIElementGetTypeID();
}

static bool secure(AXUIElementRef element) {
    return [attribute(element, kAXSubroleAttribute) isEqualToString:@"AXSecureTextField"] ||
           [attribute(element, CFSTR("AXProtectedContent")) isEqual:@YES];
}

static NSString *slice(AXUIElementRef element, CFIndex start, CFIndex count) {
    if (!count) return @"";
    CFRange range = CFRangeMake(start, count);
    AXValueRef parameter = AXValueCreate(kAXValueTypeCFRange, &range);
    CFTypeRef value = nullptr;
    AXUIElementCopyParameterizedAttributeValue(element, kAXStringForRangeParameterizedAttribute, parameter, &value);
    CFRelease(parameter);
    id string = CFBridgingRelease(value);
    return [string isKindOfClass:NSString.class] ? string : nil;
}

static id parameterized(AXUIElementRef element, CFStringRef name, id parameter) {
    if (!parameter) return nil;
    CFTypeRef value = nullptr;
    AXUIElementCopyParameterizedAttributeValue(element, name, (__bridge CFTypeRef)parameter, &value);
    return CFBridgingRelease(value);
}

// Some browser documents expose text markers instead of integer offsets.
// Both ends here come from the selected range, even if a word occurs twice.
static NSString *neighborWords(AXUIElementRef web, id edge, bool before) {
    id outer = edge;
    for (int i = 0; i < 6; i++) {
        id next = parameterized(web, before ? CFSTR("AXPreviousWordStartTextMarkerForTextMarker")
                                            : CFSTR("AXNextWordEndTextMarkerForTextMarker"), outer);
        if (!next || CFGetTypeID((__bridge CFTypeRef)next) != AXTextMarkerGetTypeID() || [next isEqual:outer]) break;
        outer = next;
    }
    if (!edge || outer == edge) return @"";
    id span = CFBridgingRelease(AXTextMarkerRangeCreate(nullptr,
        (__bridge AXTextMarkerRef)(before ? outer : edge), (__bridge AXTextMarkerRef)(before ? edge : outer)));
    id text = parameterized(web, CFSTR("AXStringForTextMarkerRange"), span);
    return [text isKindOfClass:NSString.class] && [text length] <= 400 ? text : @"";
}

static NSDictionary *webSelection(AXUIElementRef web, CGPoint point, NSString *expected) {
    id markers = attribute(web, CFSTR("AXSelectedTextMarkerRange"));
    if (!markers || CFGetTypeID((__bridge CFTypeRef)markers) != AXTextMarkerRangeGetTypeID()) return nil;
    id text = parameterized(web, CFSTR("AXStringForTextMarkerRange"), markers);
    if (![text isKindOfClass:NSString.class] || ![text length] || [text length] > 8000 ||
        (expected && ![text isEqual:expected])) return nil;
    AXTextMarkerRangeRef range = (__bridge AXTextMarkerRangeRef)markers;
    id start = CFBridgingRelease(AXTextMarkerRangeCopyStartMarker(range));
    id end = CFBridgingRelease(AXTextMarkerRangeCopyEndMarker(range));
    return @{@"type":@"selection", @"text":text, @"x":@(point.x), @"y":@(point.y),
             @"before":neighborWords(web, start, true), @"after":neighborWords(web, end, false)};
}

static bool isChrome(NSRunningApplication *source) {
    NSString *bundle = source.bundleIdentifier;
    return [bundle isEqual:@"com.google.Chrome"] || [bundle hasPrefix:@"com.google.Chrome."];
}

static void requestChromeTextTree(NSRunningApplication *source) {
    NSTimeInterval now = NSProcessInfo.processInfo.systemUptime;
    if ([source isEqual:preparedChrome] && now - chromeRequestedAt < 30) return;
    AXUIElementRef app = AXUIElementCreateApplication(source.processIdentifier);
    AXUIElementSetMessagingTimeout(app, 0.3f);
    // Chromium handles this on the application object and may debounce activation
    // for two seconds. Sending it on every mouse-up would postpone readiness.
    AXUIElementSetAttributeValue(app, CFSTR("AXEnhancedUserInterface"), kCFBooleanTrue);
    CFRelease(app);
    preparedChrome = source;
    chromeRequestedAt = now;
}

static NSDictionary *selection(AXUIElementRef element, CGPoint pointer) {
    id raw = attribute(element, kAXSelectedTextAttribute);
    id value = attribute(element, kAXSelectedTextRangeAttribute);
    CFRange range = CFRangeMake(0, 0);
    bool hasRange = value && CFGetTypeID((__bridge CFTypeRef)value) == AXValueGetTypeID() &&
        AXValueGetValue((__bridge AXValueRef)value, kAXValueTypeCFRange, &range) &&
        range.location >= 0 && range.length > 0 && range.length <= 8000 && range.location <= LONG_MAX - range.length;
    if (!raw && hasRange) raw = slice(element, range.location, range.length);
    if (![raw isKindOfClass:NSString.class] || ![raw length] || [raw length] > 8000) return nil;
    NSMutableDictionary *item = [@{@"type": @"selection", @"text":raw, @"x":@(pointer.x), @"y":@(pointer.y)} mutableCopy];
    if (!hasRange || range.length != (CFIndex)[raw length]) return item;
    id length = attribute(element, kAXNumberOfCharactersAttribute);
    CFIndex end = range.location + range.length;
    // Without a known right boundary it is still safe to read the left side.
    CFIndex total = [length isKindOfClass:NSNumber.class] ? [length longValue] : end;
    if (total < end) return item;
    CFIndex left = MIN(400, range.location);
    CFIndex right = MIN(400, total - end);
    // One bounded read verifies this occurrence before supplying any context.
    NSString *excerpt = slice(element, range.location-left, left+range.length+right);
    if (excerpt.length != (NSUInteger)(left+range.length+right) ||
        ![[excerpt substringWithRange:NSMakeRange(left, range.length)] isEqual:raw]) return item;
    NSString *before = [excerpt substringToIndex:left];
    NSString *after = [excerpt substringFromIndex:left+range.length];
    if (before.length && CFStringIsSurrogateLowCharacter([before characterAtIndex:0])) before = [before substringFromIndex:1];
    if (after.length && CFStringIsSurrogateHighCharacter([after characterAtIndex:after.length-1])) after = [after substringToIndex:after.length-1];
    item[@"before"] = before;
    item[@"after"] = after;
    return item;
}

static NSDictionary *snapshot(pid_t pid, CGPoint point, bool *sensitive = nullptr) {
    if (sensitive) *sensitive = true;
    if (IsSecureEventInputEnabled()) return nil;
    AXUIElementRef app = AXUIElementCreateApplication(pid);
    AXUIElementSetMessagingTimeout(app, 0.25f);
    id focused = attribute(app, kAXFocusedUIElementAttribute);
    AXUIElementRef hit = nullptr;
    AXUIElementCopyElementAtPosition(app, point.x, point.y, &hit);
    CFRelease(app);
    // Walk the clicked element's parents: browser text often exposes selection
    // on its web area. Do not pick up an unrelated editor's old selection.
    id current = CFBridgingRelease(hit);
    if (isElement(focused) && secure((__bridge AXUIElementRef)focused)) return nil;
    NSMutableArray *chain = [NSMutableArray array];
    while (isElement(current) && chain.count < 18 && ![chain containsObject:current]) {
        AXUIElementRef el = (__bridge AXUIElementRef)current;
        if (secure(el)) return nil;
        NSString *role = attribute(el, kAXRoleAttribute);
        if ([role isEqualToString:@"AXWindow"] || [role isEqualToString:@"AXApplication"]) break;
        [chain addObject:current];
        current = attribute(el, kAXParentAttribute);
    }
    NSDictionary *selected = nil;
    for (id candidate in chain) {
        AXUIElementRef element = (__bridge AXUIElementRef)candidate;
        NSDictionary *item = selection(element, point);
        if (!selected) selected = item;
        if (item && [item[@"text"] isEqual:selected[@"text"]] && (item[@"before"] || item[@"after"])) return item;
        if ([attribute(element, kAXRoleAttribute) isEqual:@"AXWebArea"]) {
            NSDictionary *marked = webSelection(element, point, selected[@"text"]);
            if (marked) return marked;
        }
    }
    if (sensitive) *sensitive = false;
    return selected;
}

static void inspectGesture(NSRunningApplication *source, CGPoint point, unsigned long token, bool retry) {
    pid_t pid = source.processIdentifier;
    if (!monitor || token != generation || NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != pid) return;
    dispatch_async(queries, ^{ @autoreleasepool {
        if (token != generation) return;
        bool sensitive = false;
        NSDictionary *item = snapshot(pid, point, &sensitive);
        if (item) {
            dispatch_async(dispatch_get_main_queue(), ^{
                if (token == generation && monitor && !IsSecureEventInputEnabled() &&
                    NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == pid) emit(item);
            });
        } else if (retry && !sensitive && isChrome(source) && token == generation) {
            requestChromeTextTree(source);
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 2300 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
                inspectGesture(source, point, token, false);
            });
        }
    }});
}

static void deliver(napi_env env, napi_value js, void *, void *data) {
    NSData *bytes = CFBridgingRelease(data);
    if (!env || !js) return;
    napi_value arg, receiver;
    napi_get_undefined(env, &receiver);
    napi_create_string_utf8(env, (const char *)bytes.bytes, bytes.length, &arg);
    napi_call_function(env, receiver, js, 1, &arg, nullptr);
}

static void emit(NSDictionary *event) {
    if (!callback) return;
    NSData *json = [NSJSONSerialization dataWithJSONObject:event options:0 error:nil];
    if (!json) return;
    void *data = (void *)CFBridgingRetain(json);
    if (napi_call_threadsafe_function(callback, data, napi_tsfn_nonblocking) != napi_ok) CFRelease(data);
}

static void stopMonitor() {
    generation++;
    if (monitor) { [NSEvent removeMonitor:monitor]; monitor = nil; }
    if (callback) { napi_release_threadsafe_function(callback, napi_tsfn_abort); callback = nullptr; }
}

static napi_value stop(napi_env env, napi_callback_info) { stopMonitor(); return nullptr; }

static napi_value start(napi_env env, napi_callback_info info) {
    stopMonitor();
    size_t count = 1;
    napi_value fn, name, result;
    napi_get_cb_info(env, info, &count, &fn, nullptr, nullptr);
    napi_create_string_utf8(env, "ReadingTime selection", NAPI_AUTO_LENGTH, &name);
    if (!AXIsProcessTrusted() || count != 1 || napi_create_threadsafe_function(env, fn, nullptr, name,
        0, 1, nullptr, nullptr, nullptr, deliver, &callback) != napi_ok) {
        napi_get_boolean(env, false, &result); return result;
    }
    if (!queries) queries = dispatch_queue_create("com.readingtime.selection", DISPATCH_QUEUE_SERIAL);
    __block CGPoint down = CGPointZero;
    __block bool pressed = false;
    monitor = [NSEvent addGlobalMonitorForEventsMatchingMask:(NSEventMaskLeftMouseDown | NSEventMaskLeftMouseUp)
        handler:^(NSEvent *event) {
        if (!event.CGEvent) return;
        CGPoint point = CGEventGetLocation(event.CGEvent);
        if (event.type == NSEventTypeLeftMouseDown) {
            generation++; down = point; pressed = true; emit(@{@"type":@"dismiss"}); return;
        }
        bool gesture = pressed && (event.clickCount >= 2 || hypot(point.x-down.x, point.y-down.y) >= 3);
        pressed = false;
        NSRunningApplication *source = NSWorkspace.sharedWorkspace.frontmostApplication;
        pid_t pid = source.processIdentifier;
        if (!gesture || pid <= 0 || pid == getpid()) return;
        unsigned long token = generation;
        // Let the source application commit its selection on mouse-up.
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 90000000), dispatch_get_main_queue(), ^{
            inspectGesture(source, point, token, true);
        });
    }];
    if (!monitor) stopMonitor();
    napi_get_boolean(env, monitor != nil, &result); return result;
}

NAPI_MODULE_INIT() {
    napi_property_descriptor props[] = {
        {"start", nullptr, start, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"stop", nullptr, stop, nullptr, nullptr, nullptr, napi_default, nullptr}
    };
    napi_define_properties(env, exports, 2, props);
    napi_add_env_cleanup_hook(env, [](void *) { stopMonitor(); }, nullptr);
    return exports;
}
