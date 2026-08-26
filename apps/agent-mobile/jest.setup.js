/* global jest */
// react-native-keyboard-controller is a native module; mock it for jest so the
// component tree renders without the native bindings. The published package
// excludes its own __mocks__, so provide a minimal passthrough here. The
// passthroughs return their children directly (no JSX / createElement) to avoid
// NativeWind's babel transform inside the mock factory.
jest.mock('react-native-keyboard-controller', () => {
  const Passthrough = ({ children }) => children ?? null;
  return {
    KeyboardProvider: Passthrough,
    KeyboardStickyView: Passthrough,
    KeyboardAvoidingView: Passthrough,
    KeyboardAwareScrollView: Passthrough,
    KeyboardEvents: {
      addListener: () => ({ remove: () => {} }),
    },
    useKeyboardHandler: () => {},
    useReanimatedKeyboardAnimation: () => ({
      height: { value: 0 },
      progress: { value: 0 },
    }),
  };
});
