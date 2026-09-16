/* global jest */
// uniwind: styling is a Metro transform plus a CSS runtime, neither present
// under jest (no Metro, no generated artifacts). Its `react-native` entry is
// untransformed TypeScript in a nested node_modules, so it cannot be required
// directly here. Mock the hooks the app uses: className props are inert strings
// in tests, and useColor (src/lib/theme) reads through useCSSVariable, so this
// covers it too. Colors resolve to undefined, which is harmless for rendering.
jest.mock('uniwind', () => ({
  useCSSVariable: () => undefined,
  useResolveClassNames: () => ({}),
  useUniwind: () => ({ themeName: 'light' }),
  withUniwind: (component) => component,
  Uniwind: { getCSSVariable: () => undefined },
}));

// react-native-safe-area-context needs a SafeAreaProvider (expo-router mounts
// one in the app, but tests render screens directly). Provide zero insets and a
// fixed frame so useSafeAreaInsets works headless. Passthroughs return children
// directly (no JSX) so no transform runs inside the factory.
jest.mock('react-native-safe-area-context', () => {
  const insets = { top: 0, right: 0, bottom: 0, left: 0 };
  const frame = { x: 0, y: 0, width: 390, height: 844 };
  const Passthrough = ({ children }) => children ?? null;
  return {
    SafeAreaProvider: Passthrough,
    SafeAreaView: Passthrough,
    useSafeAreaInsets: () => insets,
    useSafeAreaFrame: () => frame,
    initialWindowMetrics: { insets, frame },
  };
});

// react-native-reanimated 4 pulls in react-native-worklets, whose native module
// is absent under jest ("Cannot read properties of undefined (reading
// 'loadUnpackers')"), and its own shipped mock imports the same failing
// initializers (software-mansion/react-native-reanimated#8806). So provide a
// minimal hand mock: Animated.View renders a plain RN View (animations are
// no-ops, so a removed row unmounts immediately) and the layout-animation
// builders / hooks are inert. The factory creates NO element (Animated.View
// aliases the RN View, which ignores the extra entering/exiting/layout props),
// which also keeps JSX out of the hoisted jest.mock factory (a factory runs
// before imports, so an in-factory JSX/React reference can be out of scope).
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
    // Return the target synchronously and complete it immediately so tests can
    // observe work that is deliberately deferred until a slide finishes.
    withTiming: (v, _config, callback) => {
      callback?.(true);
      return v;
    },
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
// directly (no JSX) since a hoisted jest.mock factory can't safely hold JSX.
// The latest Pan exposes its registered lifecycle callbacks so a screen test can
// assert the swipe's write outcome; native recognition and arbitration remain
// Pixel-only verification.
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
      g[m] = (argument) => {
        if (m.startsWith('on') && typeof argument === 'function') {
          g[`__${m}`] = argument;
        }
        return g;
      };
    }
    return g;
  };
  const makePanGesture = () => {
    const gesture = makeGesture();
    global.__lastPanGesture = gesture;
    return gesture;
  };
  const Passthrough = ({ children }) => children ?? null;
  return {
    __esModule: true,
    // Compose helpers return a gesture-like object; GestureDetector ignores it.
    Gesture: {
      Pan: makePanGesture,
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
// it — a hoisted jest.mock factory runs before imports, so an in-factory JSX
// reference to React can be out of scope. React.createElement via the
// mock-prefixed require sidesteps that. It renders a plain
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
// passthroughs return their children directly (no JSX / createElement), which a
// hoisted jest.mock factory can't safely hold.
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
// since a hoisted jest.mock factory can't safely hold JSX.
//
// The mock also enforces @expo/ui's host invariant: on Android every Jetpack
// Compose component (Button, Column, Row, Text, TextInput, Icon) must be wrapped
// in a `<Host>` or it fails to render with a Compose error banner. `Host` and
// `BottomSheet` (which wraps its own Host natively) provide a context; the
// hosted components throw when that context is absent. Without this guard a bare
// `@expo/ui` component looks fine under jest but breaks on device.
const mockReactForExpoUi = require('react');
jest.mock('@expo/ui', () => {
  const {
    View,
    Text: RNText,
    TextInput: RNTextInput,
    Pressable,
  } = require('react-native');
  const HostContext = mockReactForExpoUi.createContext(false);
  const useHosted = (name) => {
    if (!mockReactForExpoUi.useContext(HostContext)) {
      throw new Error(
        `@expo/ui ${name} must be rendered inside a <Host> (or a component that provides one, e.g. BottomSheet).`,
      );
    }
  };
  const Host = ({ children }) =>
    mockReactForExpoUi.createElement(
      HostContext.Provider,
      { value: true },
      mockReactForExpoUi.createElement(View, null, children),
    );
  const Column = ({ children }) => {
    useHosted('Column');
    return mockReactForExpoUi.createElement(View, null, children);
  };
  const Row = ({ children }) => {
    useHosted('Row');
    return mockReactForExpoUi.createElement(View, null, children);
  };
  const Text = ({ children }) => {
    useHosted('Text');
    return mockReactForExpoUi.createElement(RNText, null, children);
  };
  const Button = ({ label, onPress, children }) => {
    useHosted('Button');
    return mockReactForExpoUi.createElement(
      Pressable,
      { accessibilityRole: 'button', accessibilityLabel: label, onPress },
      children ??
        (label != null ? mockReactForExpoUi.createElement(RNText, null, label) : null),
    );
  };
  const Icon = ({ testID }) => {
    useHosted('Icon');
    return mockReactForExpoUi.createElement(View, { testID });
  };
  Icon.select = () => 'mock-icon';
  const TextInput = ({
    value,
    defaultValue,
    onChangeText,
    onBlur,
    onSubmitEditing,
    placeholder,
    autoFocus,
    returnKeyType,
    testID,
  }) => {
    useHosted('TextInput');
    return mockReactForExpoUi.createElement(RNTextInput, {
      value: value ?? defaultValue,
      onChangeText,
      onBlur,
      onSubmitEditing,
      placeholder,
      autoFocus,
      returnKeyType,
      testID,
    });
  };
  const BottomSheet = ({ isPresented, children }) =>
    isPresented
      ? mockReactForExpoUi.createElement(
          HostContext.Provider,
          { value: true },
          mockReactForExpoUi.createElement(
            View,
            { accessibilityLabel: 'sheet' },
            children,
          ),
        )
      : null;
  return {
    __esModule: true,
    Host,
    Column,
    Row,
    Text,
    Button,
    Icon,
    TextInput,
    BottomSheet,
  };
});

// AsyncStorage has no native module under jest (it throws "NativeModule:
// AsyncStorage is null" on import). Use the library's official in-memory jest
// mock so the icon-suggestion cache (and any other AsyncStorage user) works
// headless.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
