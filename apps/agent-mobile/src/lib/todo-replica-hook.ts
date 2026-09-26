import { useTodoDataContext } from './todo-data-context';

export const useTodoReplica = () => useTodoDataContext()?.replica ?? null;
