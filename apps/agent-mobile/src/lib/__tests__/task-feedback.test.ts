import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { defaultToastController, localToday, tomorrow } from '@zero/agent-core';
import { showTaskDestination } from '../task-feedback';
const mockNavigate = jest.fn();
jest.mock('expo-router', () => ({ router: { navigate: (...args: unknown[]) => mockNavigate(...args) } }));
afterEach(() => { defaultToastController.dismiss(); mockNavigate.mockReset(); });
describe('task destination feedback', () => {
  it('links a future task filed to a project to Upcoming', () => {
    showTaskDestination({ showUpDate: tomorrow(localToday()), projectId: 'p' }, [], 'created');
    const [toast] = defaultToastController.getSnapshot();
    expect(toast.message).toBe('Filed to project');
    expect(toast.description).toBe('Upcoming');
    toast.action?.onPress();
    expect(mockNavigate).toHaveBeenCalledWith('/upcoming');
  });
  it('links an undated project task to its project, not Home', () => {
    showTaskDestination({ showUpDate: null, projectId: 'p' }, [{
      id: 'p', icon: '🎓', title: 'Diploma', description: null,
      state: 'in-play', createdAt: '2026-09-23T00:00:00Z',
    }], 'moved');
    expect(defaultToastController.getSnapshot()[0].description).toBe('🎓 Diploma');
    defaultToastController.getSnapshot()[0].action?.onPress();
    expect(mockNavigate).toHaveBeenCalledWith('/projects/p', { withAnchor: true });
  });
  it('links a loose undated task to Home', () => {
    showTaskDestination({ showUpDate: null, projectId: null }, [], 'moved');
    expect(defaultToastController.getSnapshot()[0].description).toBe('Home');
    defaultToastController.getSnapshot()[0].action?.onPress();
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });
});
