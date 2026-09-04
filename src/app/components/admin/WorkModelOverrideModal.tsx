import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../ui/dialog';
import { Label } from '../ui/label';
import { Input } from '../ui/input';
import { Checkbox } from '../ui/checkbox';
import { Switch } from '../ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Button } from '../ui/button';
import { toast } from 'sonner';
import { Loader2, Sliders, AlertCircle } from 'lucide-react';
import { User, WorkModelOverride } from '../../lib/auth';
import { dbService } from '../../lib/database';
import { listWorkModels, type WorkModel } from '../../../services/workModelsService';

interface WorkModelOverrideModalProps {
  user: User | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUserUpdated: (user: User) => void;
}

const EMPTY_OVERRIDE: WorkModelOverride = {
  hasCustomRules: true,
  noOvertime: false,
  overtimeLimit: 8,
  overtimeMultiplier: 1.5,
  doubleTimeLimit: 12,
  doubleTimeMultiplier: 2.0,
  weeklyOvertimeLimit: 40,
};

export function WorkModelOverrideModal({ user, open, onOpenChange, onUserUpdated }: WorkModelOverrideModalProps) {
  const [models, setModels] = useState<WorkModel[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [workModelId, setWorkModelId] = useState<string>('');
  const [hasCustomRules, setHasCustomRules] = useState(false);
  const [override, setOverride] = useState<WorkModelOverride>(EMPTY_OVERRIDE);
  const [saving, setSaving] = useState(false);
  // Snapshot of the form exactly as initialized on open — the dirty baseline
  // for the Save button (disabled until something differs, re-disabled when
  // every field is reverted to its initial value).
  const [initialForm, setInitialForm] = useState<{
    workModelId: string;
    hasCustomRules: boolean;
    override: WorkModelOverride;
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadingModels(true);
    listWorkModels()
      .then(list => {
        setModels(list);
        if (user) {
          const initialWorkModelId = user.workModelId || '';
          const existing = user.workModelOverride;
          const initialHasCustom = !!(existing && existing.hasCustomRules);
          const initialOverride = initialHasCustom
            ? { ...EMPTY_OVERRIDE, ...existing }
            : EMPTY_OVERRIDE;
          setWorkModelId(initialWorkModelId);
          setHasCustomRules(initialHasCustom);
          setOverride(initialOverride);
          setInitialForm({
            workModelId: initialWorkModelId,
            hasCustomRules: initialHasCustom,
            override: initialOverride,
          });
        }
      })
      .catch(e => {
        console.error(e);
        toast.error('Failed to load work models');
      })
      .finally(() => setLoadingModels(false));
  }, [open, user]);

  const updateOverride = (patch: Partial<WorkModelOverride>) => {
    setOverride(prev => ({ ...prev, ...patch }));
  };

  // Dirty when the base model, the custom-rules toggle, or any override value
  // differs from the open-time snapshot. Override numeric/boolean fields are
  // compared key-by-key (the editable set under EMPTY_OVERRIDE).
  const isDirty = (() => {
    if (!initialForm) return false;
    if (workModelId !== initialForm.workModelId) return true;
    if (hasCustomRules !== initialForm.hasCustomRules) return true;
    const keys: (keyof WorkModelOverride)[] = [
      'noOvertime', 'overtimeLimit', 'overtimeMultiplier',
      'doubleTimeLimit', 'doubleTimeMultiplier', 'weeklyOvertimeLimit',
    ];
    return keys.some(k => (override[k] ?? undefined) !== (initialForm.override[k] ?? undefined));
  })();

  const handleSave = async () => {
    if (!user || !isDirty) return;
    setSaving(true);
    try {
      // Keep the two parallel work-model fields consistent (see
      // resolveWorkModelLabel in AdminPanel): this modal is the only write
      // path that used to persist workModelId WITHOUT the legacy workModel
      // string, leaving the string stale in Firestore — so the console and
      // every legacy reader (auth.ts, database.ts mappers, repairRunawayShifts,
      // the Remote pay-cycle trigger in Analytics/Payroll) kept treating the
      // user as their old model. Derive the canonical string from the chosen
      // model's name and write both together.
      const selectedName = models.find(m => m.id === workModelId)?.name ?? '';
      const legacyWorkModel: User['workModel'] =
        selectedName.toLowerCase().includes('remote') ? 'Remote' : 'On-site';

      const patch: { workModelId: string; workModel: User['workModel']; workModelOverride: WorkModelOverride | null } = {
        workModelId,
        workModel: legacyWorkModel,
        workModelOverride: hasCustomRules
          ? { ...override, hasCustomRules: true }
          : { hasCustomRules: false },
      };
      const updated = await dbService.updateUser(user.uid, patch);
      onUserUpdated(updated);
      toast.success('Work model settings saved');
      onOpenChange(false);
    } catch (e) {
      console.error(e);
      toast.error('Failed to save work model settings');
    } finally {
      setSaving(false);
    }
  };

  const selectedModel = models.find(m => m.id === workModelId);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!saving) onOpenChange(o); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-slate-800">
            <Sliders className="size-5 text-indigo-500" />
            Work Model & Overtime — {user?.name}
          </DialogTitle>
          <DialogDescription>
            Assign a base work model and optionally override overtime rules for this user.
          </DialogDescription>
        </DialogHeader>

        {loadingModels ? (
          <div className="py-8 text-center text-sm text-slate-500">Loading work models...</div>
        ) : (
          <div className="space-y-5">
            <div>
              <Label>Base Work Model</Label>
              <Select value={workModelId} onValueChange={setWorkModelId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a work model" />
                </SelectTrigger>
                <SelectContent>
                  {models.map(m => (
                    <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedModel && (
                <p className="text-xs text-slate-400 mt-1">
                  {selectedModel.noOvertime
                    ? 'Base model has overtime disabled.'
                    : `Base: OT after ${selectedModel.overtimeLimit}h (${selectedModel.overtimeMultiplier}×) · DT after ${selectedModel.doubleTimeLimit}h (${selectedModel.doubleTimeMultiplier}×) · Weekly cap ${selectedModel.weeklyOvertimeLimit}h`}
                </p>
              )}
            </div>

            <div className="border-t pt-4">
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="customRules">Enable Custom Overtime Overrides for this user</Label>
                  <p className="text-xs text-slate-400 mt-0.5">Override the base work model's rules with user-specific values.</p>
                </div>
                <Switch
                  id="customRules"
                  checked={hasCustomRules}
                  onCheckedChange={setHasCustomRules}
                />
              </div>
            </div>

            {hasCustomRules && (
              <>
                <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-lg p-3">
                  <Checkbox
                    id="overrideNoOvertime"
                    checked={!!override.noOvertime}
                    onCheckedChange={(c) => updateOverride({ noOvertime: !!c })}
                  />
                  <Label htmlFor="overrideNoOvertime" className="text-amber-900">No Overtime (exempt this user from OT/DT)</Label>
                </div>

                <fieldset disabled={!!override.noOvertime} className={override.noOvertime ? 'opacity-40 pointer-events-none' : ''}>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="col-span-2">
                      <Label>Weekly Overtime Cap (Hours)</Label>
                      <Input
                        type="number"
                        min="0"
                        step="0.5"
                        value={override.weeklyOvertimeLimit ?? 40}
                        onChange={(e) => updateOverride({ weeklyOvertimeLimit: parseFloat(e.target.value) || 0 })}
                      />
                    </div>
                    <div>
                      <Label>Daily Overtime Threshold (hours)</Label>
                      <Input
                        type="number"
                        min="0"
                        max="24"
                        step="0.5"
                        value={override.overtimeLimit ?? 8}
                        onChange={(e) => updateOverride({ overtimeLimit: parseFloat(e.target.value) || 0 })}
                      />
                    </div>
                    <div>
                      <Label>Overtime Multiplier</Label>
                      <Input
                        type="number"
                        min="1"
                        step="0.1"
                        value={override.overtimeMultiplier ?? 1.5}
                        onChange={(e) => updateOverride({ overtimeMultiplier: parseFloat(e.target.value) || 1 })}
                      />
                    </div>
                    <div>
                      <Label>Double Time Threshold (hours)</Label>
                      <Input
                        type="number"
                        min="0"
                        max="24"
                        step="0.5"
                        value={override.doubleTimeLimit ?? 12}
                        onChange={(e) => updateOverride({ doubleTimeLimit: parseFloat(e.target.value) || 0 })}
                      />
                    </div>
                    <div>
                      <Label>Double Time Multiplier</Label>
                      <Input
                        type="number"
                        min="1"
                        step="0.1"
                        value={override.doubleTimeMultiplier ?? 2.0}
                        onChange={(e) => updateOverride({ doubleTimeMultiplier: parseFloat(e.target.value) || 1 })}
                      />
                    </div>
                  </div>
                </fieldset>

                {!workModelId && (
                  <p className="text-xs text-amber-600 flex items-center gap-1.5">
                    <AlertCircle className="size-3.5" />
                    No base work model selected — overrides will apply but inheritance falls back to defaults.
                  </p>
                )}
              </>
            )}

            {hasCustomRules === false && workModelId && (
              <p className="text-xs text-slate-500">
                This user will inherit all overtime rules from their assigned base work model.
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving || loadingModels || !isDirty}>
            {saving ? <Loader2 className="size-4 mr-2 animate-spin" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
