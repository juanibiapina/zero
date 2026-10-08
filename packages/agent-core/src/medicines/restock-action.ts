import { messageOf } from "../errors";
import type { TaskdoReplica } from "../taskdo/replica";
import { toast } from "../toast/controller";
import { pillCount } from "./supply";

// Add bought pills (completing the restock Task when there is one) and raise
// the shared Undo snackbar, which takes them away and reopens the Task.
export async function restockWithUndo(opts: {
  replica: TaskdoReplica;
  medicineId: string;
  amount: number;
  taskId?: string;
  onError: (message: string) => void;
}): Promise<void> {
  const { replica, medicineId, amount, taskId, onError } = opts;
  try {
    const restock = await replica.medicines.restock(medicineId, amount, taskId);
    toast(`Restocked ${pillCount(amount)}`, {
      id: "undo",
      action: {
        label: "Undo",
        onPress: () => { replica.medicines.undoRestock(medicineId, restock, taskId).catch((e) => onError(messageOf(e))); },
      },
    });
  } catch (e) {
    onError(messageOf(e));
  }
}
