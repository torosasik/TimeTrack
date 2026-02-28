jest.mock('./authService', () => ({
    provisionUser: jest.fn(),
}));

import { parseUserCSV } from './bulkImportService';

describe('bulkImportService', () => {
    describe('parseUserCSV', () => {
        it('should parse basic CSV with header', () => {
            const csv = `name,email,role,active
Test User,test@example.com,employee,true
Admin User,admin@example.com,admin,true`;

            const users = parseUserCSV(csv);

            expect(users).toHaveLength(2);
            expect(users[0]).toEqual(expect.objectContaining({
                name: 'Test User',
                email: 'test@example.com',
                role: 'employee',
                active: true,
                sendInvite: true
            }));
            expect(users[1]).toEqual(expect.objectContaining({
                name: 'Admin User',
                email: 'admin@example.com',
                role: 'admin'
            }));
        });

        it('should correct assign default values when fields are missing', () => {
            const csv = `name,email
Simple User,simple@example.com`;
            const users = parseUserCSV(csv);
            expect(users).toHaveLength(1);
            expect(users[0].role).toBe('employee');
            expect(users[0].active).toBe(true);
        });

        it('should handle quoted fields', () => {
            const csv = `name,email,role
"Quoted Name",quoted@example.com,manager`;
            const users = parseUserCSV(csv);
            expect(users[0].name).toBe('Quoted Name');
        });

        it('should detect password field', () => {
            const csv = `name,email,role,password
User,user@example.com,employee,SecretPass123!`;
            const users = parseUserCSV(csv);
            expect(users[0].password).toBe('SecretPass123!');
            expect(users[0].sendInvite).toBe(false);
        });
    });
});
