
/**
 * Convert an array of objects or arrays to a CSV string
 * @param headers Array of column headers
 * @param rows Array of data rows (each row matches the header order)
 */
export function generateCSV(headers: string[], rows: (string | number | undefined | null)[][]): string {
    const processRow = (row: (string | number | undefined | null)[]) => {
        return row.map(cell => {
            if (cell === null || cell === undefined) return '';
            const val = String(cell);
            // Escape quotes and wrap in quotes if contains comma, newline or quote
            if (val.includes(',') || val.includes('\n') || val.includes('"')) {
                return `"${val.replace(/"/g, '""')}"`;
            }
            return val;
        }).join(',');
    };

    const headerRow = processRow(headers);
    const dataRows = rows.map(processRow);

    return [headerRow, ...dataRows].join('\n');
}

/**
 * Trigger a browser download of a CSV file
 * @param filename Name of the file to download
 * @param content CSV string content
 */
export function downloadCSV(filename: string, content: string): void {
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');

    link.href = url;
    link.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
    link.style.visibility = 'hidden';

    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}
