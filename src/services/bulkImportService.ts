import { provisionUser } from './authService';

export interface UserImportData {
    name: string;
    email: string;
    password?: string;
    role: string;
    active: boolean;
    sendInvite: boolean;
    timezone?: string;
    error?: string;
}

export interface ImportResult {
    total: number;
    success: number;
    failed: number;
    errors: Array<{ email: string; error: string }>;
}

/**
 * Parse CSV content into user objects
 * Expected columns: name, email, role, password (optional), active (optional)
 */
export function parseUserCSV(content: string): UserImportData[] {
    const lines = content.split(/\r?\n/).filter(line => line.trim().length > 0);
    if (lines.length === 0) return [];

    const hasHeader = lines[0].toLowerCase().includes('email');
    const dataLines = hasHeader ? lines.slice(1) : lines;

    let nameIdx = 0, emailIdx = 1, roleIdx = 2, tzIdx = 3, passIdx = 4;
    if (hasHeader) {
        const headers = parseCSVLine(lines[0].toLowerCase());
        nameIdx = headers.findIndex(h => h.includes('name'));
        emailIdx = headers.findIndex(h => h.includes('email'));
        roleIdx = headers.findIndex(h => h.includes('role'));

        const foundTz = headers.findIndex(h => h.includes('timezone') || h.includes('time zone'));
        if (foundTz !== -1) tzIdx = foundTz;
        else tzIdx = -1; // Not present

        const foundPass = headers.findIndex(h => h.includes('pass'));
        if (foundPass !== -1) passIdx = foundPass;
        else passIdx = -1; // Not present
    }

    const users: UserImportData[] = [];
    const seenEmails = new Set<string>();

    for (const line of dataLines) {
        const parts = parseCSVLine(line);
        if (parts.length < 2) continue;

        const name = (nameIdx !== -1 && parts[nameIdx]) ? parts[nameIdx].trim() : '';
        const email = (emailIdx !== -1 && parts[emailIdx]) ? parts[emailIdx].trim().toLowerCase() : '';
        const role = (roleIdx !== -1 && parts[roleIdx]) ? parts[roleIdx].trim().toLowerCase() : 'employee';
        const timezone = (tzIdx !== -1 && parts[tzIdx]) ? parts[tzIdx].trim() : '';
        const password = (passIdx !== -1 && parts[passIdx]) ? parts[passIdx].trim() : '';

        if (!email) continue;

        let error: string | undefined;

        if (!['admin', 'manager', 'employee'].includes(role)) {
            error = `Invalid role '${role}'`;
        }
        if (timezone && !isValidTimeZone(timezone)) {
            error = error ? `${error}, Invalid timezone '${timezone}'` : `Invalid timezone '${timezone}'`;
        }
        if (seenEmails.has(email)) {
            error = error ? `${error}, Duplicate email` : `Duplicate email`;
        }
        seenEmails.add(email);

        users.push({
            name: name || email.split('@')[0],
            email,
            role: error && !['admin', 'manager', 'employee'].includes(role) ? 'employee' : role,
            password: password || undefined,
            active: true,
            sendInvite: !password,
            timezone: timezone || undefined,
            error
        });
    }

    return users;
}

function isValidTimeZone(tz: string): boolean {
    if (!tz) return false;
    try {
        Intl.DateTimeFormat(undefined, { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

/**
 * Basic CSV line parser that respects quotes
 */
function parseCSVLine(text: string): string[] {
    const result: string[] = [];
    let cur = '';
    let inQuote = false;

    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (inQuote) {
            if (char === '"') {
                if (i + 1 < text.length && text[i + 1] === '"') {
                    cur += '"';
                    i++;
                } else {
                    inQuote = false;
                }
            } else {
                cur += char;
            }
        } else {
            if (char === '"') {
                inQuote = true;
            } else if (char === ',') {
                result.push(cur);
                cur = '';
            } else {
                cur += char;
            }
        }
    }
    result.push(cur);
    return result.map(c => c.trim().replace(/^"|"$/g, ''));
}

/**
 * Process batch import
 */
export async function processUserImport(
    users: UserImportData[],
    createdByUid: string,
    onProgress?: (current: number, total: number) => void
): Promise<ImportResult> {
    const result: ImportResult = {
        total: users.length,
        success: 0,
        failed: 0,
        errors: []
    };

    let processed = 0;

    for (const user of users) {
        if (user.error) {
            result.failed++;
            result.errors.push({ email: user.email, error: user.error });
            processed++;
            if (onProgress) onProgress(processed, users.length);
            continue;
        }

        try {
            await provisionUser({
                email: user.email,
                name: user.name,
                role: user.role,
                createdByUid,
                sendInvite: user.sendInvite,
                password: user.password,
                timezone: user.timezone
            });
            result.success++;
        } catch (error: any) {
            console.error(`Import failed for ${user.email}:`, error);
            result.failed++;
            result.errors.push({
                email: user.email,
                error: error.message || 'Unknown error'
            });
        }

        processed++;
        if (onProgress) onProgress(processed, users.length);
    }

    return result;
}
