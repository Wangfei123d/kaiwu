function cleanRows(rows) {
    return (Array.isArray(rows) ? rows : [])
        .filter((row) => row !== null && typeof row === 'object'
            && typeof row.id === 'string' && row.id !== '')
        .map((row) => ({
            id: row.id,
            label: typeof row.label === 'string' && row.label !== '' ? row.label : row.id,
            open: row.open === true,
            active: row.active === true,
        }));
}

/** Main-process allowlist for renderer-owned Window menu state. */
export function sanitizePanelMenuReport(payload = {}) {
    return {
        views: cleanRows(payload?.views),
        tools: cleanRows(payload?.tools),
    };
}
