
import assert from 'node:assert';

/**
 * COPY OF LOGIC FROM src/services/bulkImportService.ts
 * We copy this here to verify the logic in a standalone Node environment
 * without needing complex TypeScript compilation setups for a quick verification.
 */
function parseUserCSV(content) {
    const lines = content.split(/\r?\n/).filter(line => line.trim().length > 0);
    if (lines.length === 0) return [];

    const hasHeader = lines[0].toLowerCase().includes('email');
    const dataLines = hasHeader ? lines.slice(1) : lines;

    const users = [];

    for (const line of dataLines) {
        const parts = parseCSVLine(line);

        let name = '';
        let email = '';
        let role = 'employee';
        let password = '';
        let active = true;

        if (parts.length >= 2) {
            const emailIndex = parts.findIndex(p => p.includes('@'));
            if (emailIndex !== -1) {
                email = parts[emailIndex].trim();
                // Heuristic: if name is before email
                if (emailIndex > 0) name = parts[0].trim();
            } else {
                name = parts[0].trim();
                email = parts[1].trim();
            }

            const rolePart = parts.find(p => ['admin', 'manager', 'employee'].includes(p.toLowerCase().trim()));
            if (rolePart) role = rolePart.toLowerCase().trim();

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
                name: name || email.split('@')[0],
                email,
                role: role || 'employee',
                password: password || undefined,
                active: true,
                sendInvite: !password
            });
        }
    }

    return users;
}

function parseCSVLine(text) {
    const result = [];
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

// --- TESTS ---

console.log('🧪 Verifying Bulk Import Logic...');

try {
    // Test 1: Standard CSV with Header
    const csv1 = `name,email,role,active
Test User,test@example.com,employee,true
Admin User,admin@example.com,admin,true`;
    console.log('Test 1: Standard CSV...');
    const res1 = parseUserCSV(csv1);
    assert.strictEqual(res1.length, 2);
    assert.strictEqual(res1[0].email, 'test@example.com');
    assert.strictEqual(res1[0].role, 'employee');
    assert.strictEqual(res1[1].role, 'admin');
    console.log('✅ Passed');

    // Test 2: Missing Fields (defaults)
    const csv2 = `name,email
Simple User,simple@example.com`;
    console.log('Test 2: Defaults...');
    const res2 = parseUserCSV(csv2);
    assert.strictEqual(res2[0].role, 'employee');
    assert.strictEqual(res2[0].sendInvite, true);
    console.log('✅ Passed');

    // Test 3: Quoted Fields
    const csv3 = `name,email,role
"Doe, John",john@example.com,manager`;
    console.log('Test 3: Quoted Fields...');
    const res3 = parseUserCSV(csv3);
    assert.strictEqual(res3[0].name, 'Doe, John');
    console.log('✅ Passed');

    // Test 4: Password Detection
    const csv4 = `name,email,role,password
User,user@example.com,employee,SecretPass123!`;
    console.log('Test 4: Password Detection...');
    const res4 = parseUserCSV(csv4);
    assert.strictEqual(res4[0].password, 'SecretPass123!');
    assert.strictEqual(res4[0].sendInvite, false);
    console.log('✅ Passed');

    console.log('\n🎉 All logic tests passed!');
} catch (e) {
    console.error('\n❌ Test Failed:', e);
    process.exit(1);
}
