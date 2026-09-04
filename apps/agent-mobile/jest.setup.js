/* global jest */
// react-native-reanimated 4 pulls in react-native-worklets, whose native module
// is absent under jest ("Cannot read properties of undefined (reading
// 'loadUnpackers')"), and its own shipped mock imports the same failing
// initializers (software-mansion/react-native-reanimated#8806). So provide a
// minimal hand mock: Animated.View renders a plain RN View (animations are
// no-ops, so a removed row unmounts immediately) and the layout-animation
// builders / hooks are inert. The factory creates NO element (Animated.View
// aliases the RN View, which ignores the extra entering/exiting/layout props),
// so NativeWind's babel transform has nothing to wrap and won't inject an
// out-of-scope _ReactNativeCSSInterop reference into the mock factory.
jest.mock('react-native-reanimated', () => {
  const { View, FlatList } = require('react-native');
  const builder = () => {
    const b = {
      duration: () => b,
      delay: () => b,
      springify: () => b,
      withCallback: () => b,
      build: () => b,
    };
    return b;
  };
  return {
    __esModule: true,
    default: {
      View,
      // Animated.FlatList is undefined in the real reanimated mock; alias the RN
      // FlatList so the Inbox list renders (itemLayoutAnimation is ignored).
      FlatList,
      createAnimatedComponent: (c) => c,
    },
    FadeIn: builder(),
    FadeOut: builder(),
    LinearTransition: builder(),
    ReduceMotion: { System: 'system', Always: 'always', Never: 'never' },
    ReducedMotionConfig: () => null,
    // Support the .get()/.set() shared-value API the swipe row uses, not just
    // .value, so useAnimatedStyle worklets that read x.get() don't throw.
    useSharedValue: (initial) => {
      let val = initial;
      return {
        get: () => val,
        set: (next) => {
          val = typeof next === 'function' ? next(val) : next;
        },
        get value() {
          return val;
        },
        set value(next) {
          val = next;
        },
      };
    },
    useAnimatedStyle: () => ({}),
    useReducedMotion: () => false,
    // Return the target synchronously; the completion callback (3rd arg) is a
    // no-op under jest (the commit slide is verified on-device, not in jest).
    withTiming: (v) => v,
    withSpring: (v) => v,
    Easing: { bezier: () => () => 0 },
    interpolate: () => 0,
    useReanimatedKeyboardAnimation: () => ({
      height: { value: 0 },
      progress: { value: 0 },
    }),
  };
});

// react-native-worklets: the native module is absent under jest. The swipe row
// only uses scheduleOnRN to hop a worklet callback back to JS; run it inline.
jest.mock('react-native-worklets', () => ({
  scheduleOnRN: (fn, ...args) => fn(...args),
}));

// react-native-gesture-handler is a native module; mock the pieces the screen
// uses (the row's Gesture.Pan + GestureDetector, and the root view) so the tree
// renders without native bindings. GestureDetector/RootView return children
// directly (no JSX) to avoid NativeWind's babel transform inside the factory.
// The swipe gesture itself is verified on-device (Maestro), not in jest.
jest.mock('react-native-gesture-handler', () => {
  const makeGesture = () => {
    const g = {};
    for (const m of [
      'enabled',
      'activeOffsetX',
      'activeOffsetY',
      'failOffsetY',
      'failOffsetX',
      'minDuration',
      'maxDistance',
      'runOnJS',
      'activateAfterLongPress',
      'onStart',
      'onUpdate',
      'onEnd',
      'onBegin',
      'onChange',
      'onFinalize',
    ]) {
      g[m] = () => g;
    }
    return g;
  };
  const Passthrough = ({ children }) => children ?? null;
  return {
    __esModule: true,
    // Compose helpers return a gesture-like object; GestureDetector ignores it.
    Gesture: {
      Pan: makeGesture,
      Tap: makeGesture,
      LongPress: makeGesture,
      Simultaneous: () => makeGesture(),
      Race: () => makeGesture(),
      Exclusive: () => makeGesture(),
    },
    GestureDetector: Passthrough,
    GestureHandlerRootView: Passthrough,
  };
});

// react-native-reorderable-list is native (worklet-driven); mock the pieces the
// screen uses so the tree renders under jest. ReorderableList aliases the RN
// FlatList (onReorder/itemLayoutAnimation ignored), useReorderableDrag returns a
// no-op, and reorderItems is the real pure array move. The drag is verified
// on-device (Maestro), not in jest.
// Defined at MODULE scope (mock-prefixed) so the jest.mock factory may reference
// it — a jest.mock factory cannot contain createElement/JSX, because NativeWind's
// babel transform injects an out-of-scope interop ref there. React.createElement
// (no JSX/className) keeps NativeWind from touching this. It renders a plain
// FlatList (so rows still render for tests) and stashes the list's onReorder on a
// global, so a test can drive a reorder without the native gesture
// (global.__reorderableOnReorder({from,to})); the drag itself is verified
// on-device. Reorderable-only props are stripped so FlatList sees no unknowns.
const mockReactForReorderable = require('react');
function mockReorderableList(props) {
  const { FlatList } = require('react-native');
  const { onReorder, panGesture, itemLayoutAnimation, ...rest } = props;
  global.__reorderableOnReorder = onReorder;
  return mockReactForReorderable.createElement(FlatList, rest);
}
jest.mock('react-native-reorderable-list', () => {
  const reorderItems = (data, from, to) => {
    const copy = [...data];
    const [moved] = copy.splice(from, 1);
    copy.splice(to, 0, moved);
    return copy;
  };
  return {
    __esModule: true,
    default: mockReorderableList,
    ReorderableList: mockReorderableList,
    useReorderableDrag: () => () => {},
    useReorderableDragStart: () => {},
    useReorderableDragEnd: () => {},
    useIsActive: () => false,
    reorderItems,
  };
});

// react-native-keyboard-controller is a native module; mock it for jest so the
// component tree renders without the native bindings. The published package
// excludes its own __mocks__, so provide a minimal passthrough here. The
// passthroughs return their children directly (no JSX / createElement) to avoid
// NativeWind's babel transform inside the mock factory.
jest.mock('react-native-keyboard-controller', () => {
  const Passthrough = ({ children }) => children ?? null;
  // Track keyboard listeners so tests can drive keyboard events. Fire them via
  // global.__emitKeyboardEvent('keyboardDidHide') inside an act() wrapper.
  const listeners = {};
  global.__emitKeyboardEvent = (name) => {
    (listeners[name] || []).forEach((cb) => cb());
  };
  return {
    KeyboardProvider: Passthrough,
    KeyboardStickyView: Passthrough,
    KeyboardAvoidingView: Passthrough,
    KeyboardAwareScrollView: Passthrough,
    KeyboardEvents: {
      addListener: (name, cb) => {
        (listeners[name] = listeners[name] || []).push(cb);
        return {
          remove: () => {
            listeners[name] = (listeners[name] || []).filter((l) => l !== cb);
          },
        };
      },
    },
    useKeyboardHandler: () => {},
    useReanimatedKeyboardAnimation: () => ({
      height: { value: 0 },
      progress: { value: 0 },
    }),
  };
});

// @expo/ui renders real native views (requireNativeView), which is unavailable
// under jest — like Clerk's UserButton. Provide a minimal mock that renders the
// pieces the sheet content uses as plain, queryable RN elements: BottomSheet
// shows its children only while presented; Button is a Pressable whose
// accessibilityLabel is its `label`. Defined with React.createElement (no JSX)
// so NativeWind's babel transform does not touch the factory.
const mockReactForExpoUi = require('react');
jest.mock('@expo/ui', () => {
  const { View, Text: RNText, Pressable } = require('react-native');
  const Host = ({ children }) =>
    mockReactForExpoUi.createElement(View, null, children);
  const Column = ({ children }) =>
    mockReactForExpoUi.createElement(View, null, children);
  const Text = ({ children }) =>
    mockReactForExpoUi.createElement(RNText, null, children);
  const Button = ({ label, onPress, children }) =>
    mockReactForExpoUi.createElement(
      Pressable,
      { accessibilityRole: 'button', accessibilityLabel: label, onPress },
      children ??
        (label != null ? mockReactForExpoUi.createElement(RNText, null, label) : null),
    );
  const BottomSheet = ({ isPresented, children }) =>
    isPresented
      ? mockReactForExpoUi.createElement(
          View,
          { accessibilityLabel: 'sheet' },
          children,
        )
      : null;
  return { __esModule: true, Host, Column, Text, Button, BottomSheet };
});
