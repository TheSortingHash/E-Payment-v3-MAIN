/**
 * RECONCILIATION MODULE - CHUNKED PROCESSING
 * UPDATED: Optimized for Client-Side Processing strategy.
 */

/**
 * STEP 1: INITIALIZE
 * Fetches the current database once so the client knows what to compare against.
 * This is faster than fetching the DB multiple times.
 * @return {object} A map of existing payees { "NAME": "ACCOUNT" }
 */
function getCurrentPayeeMap() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Payee_Database');
  const lastRow = sheet.getLastRow();
  
  // If DB is empty, return empty object
  if (lastRow < 2) return {};

  // Get Name (Col A) and Account (Col B) only
  const data = sheet.getRange(2, 1, lastRow - 1, 2).getValues(); 
  const dbMap = {};
  
  data.forEach(row => {
    // Normalize Key: Uppercase and trimmed
    const key = row[0].toString().toUpperCase().replace(/\s+/g, ' ').trim();
    // Value: Account Number (trimmed)
    dbMap[key] = row[1].toString().trim();
  });
  
  return dbMap;
}

/**
 * STEP 2: COMMIT BATCH
 * Saves the final list of approved new payees and updates.
 * Uses LockService to prevent conflicts.
 */
function commitReconciliationBatch(newPayeesList, updatesList) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { // Wait up to 30 seconds
    return { success: false, message: "System is busy. Please try again." };
  }

  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Payee_Database');
    const lastRow = sheet.getLastRow();
    
    // 1. Fetch current DB to get Row Indexes for Updates
    // We fetch strictly Name (Col A) to find where to update
    const currentNames = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, 1).getValues().flat() : [];
    
    // Create Map: Name -> Row Index (0-based relative to data range, so +2 for actual row)
    const nameToIndexMap = new Map();
    currentNames.forEach((name, index) => {
      const normalized = name.toString().toUpperCase().replace(/\s+/g, ' ').trim();
      nameToIndexMap.set(normalized, index + 2);
    });

    let updatedCount = 0;
    let addedCount = 0;

    // A. PERFORM UPDATES
    if (updatesList && updatesList.length > 0) {
      updatesList.forEach(item => {
        const key = item.name.toString().toUpperCase().replace(/\s+/g, ' ').trim();
        if (nameToIndexMap.has(key)) {
          const row = nameToIndexMap.get(key);
          // Update Account (Col 2)
          // setNumberFormat("@") forces it to be Text, preserving leading zeros
          sheet.getRange(row, 2).setNumberFormat("@").setValue(item.newAccount);
          updatedCount++;
        }
      });
    }

    // B. PERFORM ADDS
    if (newPayeesList && newPayeesList.length > 0) {
      const rowsToAppend = [];
      newPayeesList.forEach(item => {
        // Double check it doesn't exist (in case of race condition or duplicate in file)
        const key = item.name.toString().toUpperCase().replace(/\s+/g, ' ').trim();
        if (!nameToIndexMap.has(key)) {
          rowsToAppend.push([
            item.name,
            "'" + item.account, // Force text format with apostrophe just to be safe
            item.email,
            item.hrisId
          ]);
          // Add to local map so we don't add duplicates within the same batch
          nameToIndexMap.set(key, true); 
          addedCount++;
        }
      });

      if (rowsToAppend.length > 0) {
        // Append all new rows at once
        sheet.getRange(sheet.getLastRow() + 1, 1, rowsToAppend.length, 4).setNumberFormat("@").setValues(rowsToAppend);
      }
    }

    // C. SORT DATABASE (Maintain alphabetical order)
    if (sheet.getLastRow() > 1) {
       sheet.getRange(2, 1, sheet.getLastRow() - 1, 4).sort({ column: 1, ascending: true });
    }

    return { 
      success: true, 
      message: `Sync Complete!\n\nAdded: ${addedCount}\nUpdated: ${updatedCount}` 
    };

  } catch (e) {
    return { success: false, message: "Error: " + e.message };
  } finally {
    lock.releaseLock();
  }
}
