import { Host, Icon } from '@expo/ui';
import { useRouter } from 'expo-router';
import { View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { ListRow } from '@/components/ui/list-row';
import { Text } from '@/components/ui/text';
import { useColor } from '@/lib/theme';

const DESTINATIONS = [
  {
    label: 'Upcoming',
    href: '/browse/upcoming',
    icon: Icon.select({ ios: 'calendar', android: import('@expo/material-symbols/calendar_month.xml') }),
  },
  {
    label: 'Medicines',
    href: '/browse/medicines',
    icon: Icon.select({ ios: 'pills', android: import('@expo/material-symbols/medication.xml') }),
  },
] as const;
const DISCLOSURE_ICON = Icon.select({
  ios: 'chevron.right',
  android: import('@expo/material-symbols/chevron_right.xml'),
});

export default function BrowseScreen() {
  const router = useRouter();
  const iconColor = useColor('--color-foreground-secondary');

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Browse" />
      {DESTINATIONS.map(({ label, href, icon }) => (
        <ListRow
          key={href}
          leading={<Host matchContents><Icon name={icon} size={22} color={iconColor} /></Host>}
          trailing={<Host matchContents><Icon name={DISCLOSURE_ICON} size={20} color={iconColor} /></Host>}
          accessibilityLabel={label}
          onPress={() => router.push(href)}
          className="min-h-12"
        >
          <Text>{label}</Text>
        </ListRow>
      ))}
    </View>
  );
}
