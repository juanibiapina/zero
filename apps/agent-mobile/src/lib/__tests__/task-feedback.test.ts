import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { defaultToastController, localToday, tomorrow } from '@zero/agent-core';
import { showTaskDestination } from '../task-feedback';
const mockNavigate = jest.fn();
jest.mock('expo-router', () => ({ router: { navigate: (...args: unknown[]) => mockNavigate(...args) } }));
afterEach(() => { defaultToastController.dismiss(); mockNavigate.mockReset(); });
describe('task destination feedback', () => {
  it('links a future task to Upcoming', () => {
    showTaskDestination({ showUpDate: tomorrow(localToday()), projectId: 'p' }, [], 'scheduled');
    const [toast] = defaultToastController.getSnapshot();
    expect(toast.message).toBe('Scheduled for Tomorrow');
    toast.action?.onPress();
    expect(mockNavigate).toHaveBeenCalledWith('/upcoming');
  });
  it('links an undated project task to its project, not Home', () => {
    showTaskDestination({ showUpDate: null, projectId: 'p' }, [], 'moved');
    defaultToastController.getSnapshot()[0].action?.onPress();
    expect(mockNavigate).toHaveBeenCalledWith('/projects/p', { withAnchor: true });
  });
  it('links a loose undated task to Home', () => {
    showTaskDestination({ showUpDate: null, projectId: null }, [], 'moved');
    defaultToastController.getSnapshot()[0].action?.onPress();
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });
});
