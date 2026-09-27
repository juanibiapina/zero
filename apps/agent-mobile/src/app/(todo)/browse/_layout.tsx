import { Stack } from 'expo-router';

// Direct navigation to Upcoming retains the Browse menu beneath it.
export const unstable_settings = { initialRouteName: 'index' };

export default function BrowseStackLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
