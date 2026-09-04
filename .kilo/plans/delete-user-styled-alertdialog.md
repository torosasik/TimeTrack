# Plan: Styled AlertDialog for Admin Delete-User Confirmation

## Context & current behavior

The per-row Delete button in the "Manage Users" table (`AdminPanel.tsx`) calls
`handleDeleteUser(user.uid)` (`:170`), which gates on the **native browser
`confirm()`** dialog (`:171`):

```js
if (!confirm('Are you sure you want to delete this user? This will remove the Firestore profile. The Auth user must be deleted separately in Firebase Console.')) {
  return;
}
await dbService.deleteUserProfile(uid);
onUsersChange(allUsers.filter(u => u.uid !== uid));
toast.success('User deleted from database');
```

That works, but the native box is visually inconsistent with the now-styled
admin table. The project already ships a Radix `AlertDialog` primitive
(`src/app/components/ui/alert-dialog.tsx`) and has one styled usage to mirror
(`TodayEntry.tsx:1190-1224`: `rounded-2xl border-indigo-100 shadow-2xl`,
indigo header, Cancel + Action footer).

## Decisions (resolved with user)

1. Replace the native `confirm()` with a styled Radix `AlertDialog`.
2. **Spinner + stay-open during delete** (not fire-and-close): the dialog stays
   open while the async Firestore delete is in flight, shows a spinner, disables
   Cancel/Delete, and surfaces failures in-dialog.
3. **No extra guards** (no self-delete / admin-protection / type-to-confirm).
   Behavior is 1:1 with today's, only the confirmation surface changes.
4. **Scope: admin delete-user only.** The other native `confirm()` at
   `TodayEntry.tsx:580` (void entry) is intentionally out of scope.

## Files touched

- `src/app/components/admin/AdminPanel.tsx` (only file changed)

No new primitives needed — `AlertDialog` already exists. No service/data changes.
`dbService.deleteUserProfile` and the `onUsersChange` reactive update are reused
as-is.

## Audit / domain note (no change)

User-profile deletion is **not** a time-data correction, so the mandatory-audit
rule (`audit-mandatory-reason.md`: "modifies historical time data";
`auditLogService.ts:51` "PHASE 1: time corrections only") does not apply. The
existing `handleDeleteUser` writes no audit log and the plan preserves that.
Soft-delete (`status: 'voided'|'archived'`) rule applies to `timeEntries`, not
to `users` profile docs — a hard `deleteDoc` on the user profile is the existing
intended behavior and is unchanged.

## Implementation steps

### 1. Imports
- Add to the `lucide-react` import line (`:26`): `Loader2` (matches the
  modal-with-async-submit spinner convention in `TimeAdjustmentModal.tsx:433`).
- Add: `import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../ui/alert-dialog';`

### 2. State (near the other `useState` calls, `~:41-45`)
```ts
const [userToDelete, setUserToDelete] = useState<User | null>(null);
const [deleting, setDeleting] = useState(false);
const [deleteError, setDeleteError] = useState<string | null>(null);
```

### 3. Refactor `handleDeleteUser` → `confirmDeleteUser` (`:170-182`)
Remove the `confirm(...)` guard entirely (the dialog now owns confirmation).
Replace with an async `confirmDeleteUser` that:
- Early-returns if `!userToDelete`.
- `setDeleting(true); setDeleteError(null);`
- `await dbService.deleteUserProfile(userToDelete.uid);`
- `onUsersChange(allUsers.filter(u => u.uid !== userToDelete.uid));`
- `toast.success('User deleted from database');`
- `setUserToDelete(null);` (closes dialog) in `finally` after `setDeleting(false)`.
- `catch`: `setDeleteError(e.message || 'Failed to delete user');` +
  `toast.error(...)`; **do not** clear `userToDelete` (keep dialog open so the
  in-dialog error + Retry are visible). `setDeleting(false)` in `finally`.

Keep `handleDeleteUser`'s exact success/error toasts and the
`onUsersChange(allUsers.filter(...))` reactive update.

### 4. Repoint the Delete button (`renderDeleteButton`, `~:206`)
Change `onClick` from `handleDeleteUser(user.uid)` to
`setUserToDelete(user)` (opens the dialog). Keep `aria-label`, icon, styling.

### 5. AlertDialog markup (place near the other dialogs, e.g. after the
Create/Edit User `<Dialog>` blocks, `~:650+`). Mirror `TodayEntry` styling but
with a **destructive red** action (it's a delete, not an indigo confirm):

```tsx
<AlertDialog
  open={!!userToDelete}
  onOpenChange={(open) => {
    if (!open && !deleting) {
      setUserToDelete(null);
      setDeleteError(null);
    }
  }}
>
  <AlertDialogContent className="rounded-2xl border-red-100 shadow-2xl">
    <AlertDialogHeader>
      <AlertDialogTitle className="flex items-center gap-2 text-red-900 text-xl">
        <Trash2 className="size-6 text-red-500" />
        Delete User
      </AlertDialogTitle>
      <AlertDialogDescription className="text-slate-600 text-base space-y-2">
        <span className="block">
          Are you sure you want to delete <strong>{userToDelete?.name}</strong>?
          This will remove the Firestore profile.
        </span>
        <span className="block">
          The Auth user must be deleted separately in Firebase Console.
        </span>
      </AlertDialogDescription>
    </AlertDialogHeader>

    {deleteError && (
      <p className="text-sm text-red-600 -mt-2">{deleteError}</p>
    )}

    <AlertDialogFooter className="mt-6 gap-3 sm:gap-0">
      <AlertDialogCancel
        disabled={deleting}
        className="rounded-xl font-medium sm:w-1/2"
      >
        Cancel
      </AlertDialogCancel>
      <AlertDialogAction
        disabled={deleting}
        className="bg-red-600 hover:bg-red-700 text-white rounded-xl font-bold sm:w-1/2 disabled:opacity-60"
        onClick={async (e) => {
          e.preventDefault(); // suppress Radix auto-close; we close on success
          await confirmDeleteUser();
        }}
      >
        {deleting ? <Loader2 className="size-4 mr-2 animate-spin" /> : <Trash2 className="size-4 mr-2" />}
        {deleting ? 'Deleting…' : 'Delete'}
      </AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
```

Key Radix detail: `AlertDialogAction` auto-closes on click by default;
`e.preventDefault()` in `onClick` keeps it open so the spinner shows and the
dialog only closes when `confirmDeleteUser` clears `userToDelete` on success.
`AlertDialogCancel` is `disabled` while `deleting` so the row can't be
orphaned mid-write. `onOpenChange` ignores close attempts while `deleting`
(Esc / overlay click can't dismiss mid-flight).

## What is intentionally NOT changed

- `dbService.deleteUserProfile` (`database.ts:528`) — reused as-is.
- Success/error toast text — preserved verbatim.
- `onUsersChange(allUsers.filter(...))` reactive table update — preserved.
- The Edit button, status pill, table headers/columns — untouched.
- `TodayEntry.tsx:580` void `confirm()` — out of scope.
- No audit log, no self-delete guard, no type-to-confirm (per decision #3).

## Validation

1. `npm run lint` — expect 0 errors (314 pre-existing warnings unchanged).
2. `npm run build` — expect clean compile.
3. Manual (`npm run dev`, admin view → Manage Users):
   - Click a row's Delete → styled red AlertDialog opens, shows the user's name
     + the Firestore-vs-Auth warning.
   - Click Cancel → dialog closes, no delete, row unchanged.
   - Click Delete → button shows spinner + "Deleting…", Cancel disabled,
     overlay/Esc do not dismiss while in flight.
   - Success → toast "User deleted from database", dialog closes, row removed.
   - Failure path (e.g. revoke Firestore perms / go offline) → red error text
     appears in-dialog, dialog stays open, Delete re-enabled for retry.
   - Confirm the native browser `confirm()` box no longer appears.
4. `npm run test:rules` — **not required**; `firestore.rules` untouched.
