import { useTodoDataContext } from './todo-data-context';

export const useTasksApi = () => useTodoDataContext()?.api ?? null;
export const useProjectsApi = () => useTodoDataContext()?.projectsApi ?? null;
export const useWaitsApi = () => useTodoDataContext()?.waitsApi ?? null;
