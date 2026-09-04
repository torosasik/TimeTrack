import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Checkbox } from '../ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../ui/alert-dialog';
import { toast } from 'sonner';
import { Plus, Edit, Trash2, Loader2, ChevronDown } from 'lucide-react';
import {
  listWorkModels,
  createWorkModel,
  updateWorkModel,
  deleteWorkModel,
  type WorkModel,
  type WorkModelInput,
} from '../../../services/workModelsService';

const EMPTY_INPUT: WorkModelInput = {
  name: '',
  noOvertime: false,
  overtimeLimit: 8,
  overtimeMultiplier: 1.5,
  doubleTimeLimit: 12,
  doubleTimeMultiplier: 2.0,
  weeklyOvertimeLimit: 40,
};

export function WorkModelsCard() {
  const [models, setModels] = useState<WorkModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<{ id: string | null; input: WorkModelInput } | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<WorkModel | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [isWorkModelSettingsOpen, setIsWorkModelSettingsOpen] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const list = await listWorkModels();
      setModels(list);
    } catch (e) {
      console.error(e);
      toast.error('Failed to load work models');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, []);

  const handleSave = async () => {
    if (!editing) return;
    const trimmed = editing.input.name.trim();
    if (!trimmed) {
      toast.error('Work model name is required');
      return;
    }
    setSaving(true);
    try {
      const input = { ...editing.input, name: trimmed };
      if (editing.id) {
        const updated = await updateWorkModel(editing.id, input);
        setModels(prev => prev.map(m => m.id === updated.id ? updated : m));
      } else {
        const created = await createWorkModel(input);
        setModels(prev => [...prev, created]);
      }
      toast.success(editing.id ? 'Work model updated' : 'Work model created');
      setEditing(null);
    } catch (e) {
      console.error(e);
      toast.error('Failed to save work model');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteWorkModel(deleteTarget.id);
      setModels(prev => prev.filter(m => m.id !== deleteTarget.id));
      toast.success('Work model deleted');
      setDeleteTarget(null);
    } catch (e) {
      console.error(e);
      toast.error('Failed to delete work model');
    } finally {
      setDeleting(false);
    }
  };

  const updateInput = (patch: Partial<WorkModelInput>) => {
    setEditing(prev => prev ? { ...prev, input: { ...prev.input, ...patch } } : prev);
  };

  return (
    <Card className="border border-white/60 shadow-xl bg-white/70 backdrop-blur-xl rounded-2xl gap-0">
      <CardHeader className="bg-white/40 pt-3.5 pb-[15px] gap-0">
        <button
          type="button"
          onClick={() => setIsWorkModelSettingsOpen((open) => !open)}
          aria-expanded={isWorkModelSettingsOpen}
          className="w-full flex items-center justify-between text-left"
        >
          <CardTitle className="text-slate-800 font-bold">Work Model Settings</CardTitle>
          <ChevronDown
            className={`size-5 text-slate-500 transition-transform duration-200 ${isWorkModelSettingsOpen ? 'rotate-180' : 'rotate-0'}`}
          />
        </button>
      </CardHeader>
      {isWorkModelSettingsOpen && (
        <CardContent className="pt-2">
          {loading ? (
            <div className="py-8 text-center text-sm text-slate-500">Loading work models...</div>
          ) : models.length === 0 ? (
            <div className="py-8 text-center text-sm text-slate-500">No work models configured.</div>
          ) : (
            <div className="space-y-3">
              {models.map(m => (
                <div key={m.id} className="flex items-center justify-between gap-4 border border-slate-200 rounded-xl p-4 bg-slate-50/50">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-slate-800">{m.name}</span>
                      {m.noOvertime && (
                        <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-200">
                          No Overtime
                        </span>
                      )}
                    </div>
                    {m.noOvertime ? (
                      <p className="text-xs text-slate-500 mt-1">Overtime disabled for this work model.</p>
                    ) : (
                      <p className="text-xs text-slate-500 mt-1">
                        OT after {m.overtimeLimit}h ({m.overtimeMultiplier}×) · DT after {m.doubleTimeLimit}h ({m.doubleTimeMultiplier}×) · Weekly OT cap {m.weeklyOvertimeLimit}h
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button variant="ghost" size="sm" className="h-8 w-8 p-0 hover:bg-muted/80 text-muted-foreground hover:text-foreground" onClick={() => setEditing({ id: m.id, input: { ...m } })}>
                      <Edit className="size-4" />
                    </Button>
                    <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-red-500 hover:text-red-700 hover:bg-red-50" onClick={() => setDeleteTarget(m)}>
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="mt-3">
            <Button variant="outline" onClick={() => setEditing({ id: null, input: { ...EMPTY_INPUT } })}>
              <Plus className="size-4 mr-2" />
              Add Work Model
            </Button>
          </div>
        </CardContent>
      )}

      {/* Add / Edit Dialog */}
      <Dialog open={!!editing} onOpenChange={(open) => { if (!open && !saving) setEditing(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing?.id ? 'Edit Work Model' : 'Add Work Model'}</DialogTitle>
            <DialogDescription>
              Configure the overtime thresholds and multipliers for this work model.
            </DialogDescription>
          </DialogHeader>
          {editing && (
            <div className="space-y-4">
              <div>
                <Label>Work Model Name</Label>
                <Input
                  value={editing.input.name}
                  onChange={(e) => updateInput({ name: e.target.value })}
                  placeholder="e.g. Hybrid"
                />
              </div>

              <div className="flex items-center gap-2 border-b border-slate-100 pb-4">
                <Checkbox
                  id="noOvertime"
                  checked={editing.input.noOvertime}
                  onCheckedChange={(checked) => updateInput({ noOvertime: !!checked })}
                />
                <Label htmlFor="noOvertime">No Overtime (exempt this work model from OT/DT calculations)</Label>
              </div>

              <fieldset disabled={editing.input.noOvertime} className={editing.input.noOvertime ? 'opacity-40 pointer-events-none' : ''}>
                <div className="grid grid-cols-2 gap-4">
                  <div className="col-span-2">
                    <Label>Weekly Overtime Cap (Hours)</Label>
                    <Input
                      type="number"
                      min="0"
                      step="0.5"
                      value={editing.input.weeklyOvertimeLimit}
                      onChange={(e) => updateInput({ weeklyOvertimeLimit: parseFloat(e.target.value) || 0 })}
                    />
                    <p className="text-xs text-slate-400 mt-1">Regular hours per week before weekly overtime applies (e.g. 40).</p>
                  </div>
                  <div>
                    <Label>Overtime Threshold (hours)</Label>
                    <Input
                      type="number"
                      min="0"
                      max="24"
                      step="0.5"
                      value={editing.input.overtimeLimit}
                      onChange={(e) => updateInput({ overtimeLimit: parseFloat(e.target.value) || 0 })}
                    />
                  </div>
                  <div>
                    <Label>Overtime Multiplier</Label>
                    <Input
                      type="number"
                      min="1"
                      step="0.1"
                      value={editing.input.overtimeMultiplier}
                      onChange={(e) => updateInput({ overtimeMultiplier: parseFloat(e.target.value) || 1 })}
                    />
                  </div>
                  <div>
                    <Label>Double Time Threshold (hours)</Label>
                    <Input
                      type="number"
                      min="0"
                      max="24"
                      step="0.5"
                      value={editing.input.doubleTimeLimit}
                      onChange={(e) => updateInput({ doubleTimeLimit: parseFloat(e.target.value) || 0 })}
                    />
                  </div>
                  <div>
                    <Label>Double Time Multiplier</Label>
                    <Input
                      type="number"
                      min="1"
                      step="0.1"
                      value={editing.input.doubleTimeMultiplier}
                      onChange={(e) => updateInput({ doubleTimeMultiplier: parseFloat(e.target.value) || 1 })}
                    />
                  </div>
                </div>
              </fieldset>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? <Loader2 className="size-4 mr-2 animate-spin" /> : null}
              {editing?.id ? 'Save Changes' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open && !deleting) setDeleteTarget(null); }}
      >
        <AlertDialogContent className="rounded-2xl border-red-100 shadow-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-red-900 text-xl">
              <Trash2 className="size-6 text-red-500" />
              Delete Work Model
            </AlertDialogTitle>
            <AlertDialogDescription className="text-slate-600 text-base">
              Are you sure you want to delete <strong>{deleteTarget?.name}</strong>? Users currently assigned this work model will keep their assigned value, but it will no longer have configured overtime rules.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="mt-6 gap-3 sm:gap-0">
            <AlertDialogCancel disabled={deleting} className="rounded-xl font-medium sm:w-1/2">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              className="bg-red-600 hover:bg-red-700 text-white rounded-xl font-bold sm:w-1/2 disabled:opacity-60"
              onClick={async (e) => {
                e.preventDefault();
                await handleDelete();
              }}
            >
              {deleting ? <Loader2 className="size-4 mr-2 animate-spin" /> : <Trash2 className="size-4 mr-2" />}
              {deleting ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
