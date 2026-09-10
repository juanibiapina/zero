import { Stack } from 'expo-router';

// Anchor the stack's first screen to the list so a cross-tab deep link to
// /projects/:id (e.g. from Home) lands on the detail with the list beneath it
// and the bottom tabs visible, per Expo Router's native-tabs guidance. Without
// this anchor a cross-tab push pops back to the list (expo/expo#45786).
export const unstable_settings = { initialRouteName: 'index' };

// The Projects tab is a stack: the list (index) and a pushed detail screen
// (`[id]`), so a project opens its own screen — a destination, not a bottom
// sheet — while the bottom tab bar stays visible. Headers are off; each screen
// renders its own chrome (the list its ScreenHeader, the detail a back row), and
// the native swipe / hardware Back pops the stack. See
// docs/plans/todo-project-detail-rework.md.
export default function ProjectsStackLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
