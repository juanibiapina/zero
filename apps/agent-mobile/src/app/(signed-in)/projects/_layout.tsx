import { Stack } from 'expo-router';

// The Projects tab is a stack: the list (index) and a pushed detail screen
// (`[id]`), so a project opens its own screen — a destination, not a bottom
// sheet — while the bottom tab bar stays visible. Headers are off; each screen
// renders its own chrome (the list its ScreenHeader, the detail a back row), and
// the native swipe / hardware Back pops the stack. See
// docs/plans/todo-project-detail-rework.md.
export default function ProjectsStackLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
