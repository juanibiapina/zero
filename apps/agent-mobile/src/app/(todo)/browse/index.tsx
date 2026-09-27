import { Host, Icon } from '@expo/ui';
import { useRouter } from 'expo-router';
import { View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { ListRow } from '@/components/ui/list-row';
import { Text } from '@/components/ui/text';
import { useColor } from '@/lib/theme';

const CALENDAR_ICON = Icon.select({
  ios: 'calendar',
  android: import('@expo/material-symbols/calendar_month.xml'),
});
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
      <ListRow
        leading={<Host matchContents><Icon name={CALENDAR_ICON} size={22} color={iconColor} /></Host>}
        trailing={<Host matchContents><Icon name={DISCLOSURE_ICON} size={20} color={iconColor} /></Host>}
        accessibilityLabel="Upcoming"
        onPress={() => router.push('/browse/upcoming')}
        className="min-h-12"
      >
        <Text>Upcoming</Text>
      </ListRow>
    </View>
  );
}
