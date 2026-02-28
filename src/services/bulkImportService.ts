import { provisionUser } from './authService';

export interface UserImportData {
    name: string;
    email: string;
    password?: string;
    role: string;
    active: boolean;
    sendInvite: boolean;
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

    // Simple header detection (assuming first line is header if it contains 'email')
    const hasHeader = lines[0].toLowerCase().includes('email');
    const dataLines = hasHeader ? lines.slice(1) : lines;

    const users: UserImportData[] = [];

    for (const line of dataLines) {
        // Simple CSV splitter that respects quotes would be better, but for now specific to this app:
        // We assume standad CSV: name,email,role,password,active
        // Handling basic quotes if present
        const parts = parseCSVLine(line);

        // rudimentary mapping based on position if no header logic is complex
        // Let's try to map by assumed order: Name, Email, Role, Password, Active
        // Or Map by header if present. 

        // For robustness, let's assume a standard order if no header map, 
        // OR try to detect email by '@'.

        let name = '';
        let email = '';
        let role = 'employee';
        let password = '';
        let active = true;

        if (parts.length >= 2) {
            // Heuristic mapping
            const emailIndex = parts.findIndex(p => p.includes('@'));
            if (emailIndex !== -1) {
                email = parts[emailIndex].trim();
                // If name is before email?
                if (emailIndex > 0) name = parts[0].trim();
                // If Name is not set yet (email was first?), look for longest string? 
                // Let's enforce a standard format for simplicity for the user:
                // Name, Email, Role, Password
            } else {
                // Fallback to standard index
                name = parts[0].trim();
                email = parts[1].trim();
            }

            // Role
            const rolePart = parts.find(p => ['admin', 'manager', 'employee'].includes(p.toLowerCase().trim()));
            if (rolePart) role = rolePart.toLowerCase().trim();

            // Password (length > 6 and not email/role/name)
            const passPart = parts.find(p =>
                p.length > 5 &&
                p !== name &&
                p !== email &&
                p !== role &&
                !['true', 'false', '1', '0'].includes(p.toLowerCase())
            );
            if (passPart) password = passPart.trim();
        }

        if (email) {
            users.push({
                name: name || email.split('@')[0], // Fallback name
                email,
                role: role || 'employee',
                password: password || undefined,
                active: true, // Default active
                sendInvite: !password // If no password provided, assume invite
            });
        }
    }

    return users;
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
        try {
            await provisionUser({
                email: user.email,
                name: user.name,
                role: user.role,
                createdByUid,
                sendInvite: user.sendInvite,
                password: user.password
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
