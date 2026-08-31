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
      'failOffsetY',
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
    Gesture: { Pan: makeGesture, Tap: makeGesture },
    GestureDetector: Passthrough,
    GestureHandlerRootView: Passthrough,
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
