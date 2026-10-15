 // Copyright 2025. All rights reserved.
// Dean Ancheta
// --- CONFIGURATION ---
const CONFIG_SHEET_NAME = 'Config';
const MASTER_LIST_SHEET_NAME = 'Master_DV_List';
// --- WEB APP FUNCTIONS ---

// --- SECURE WEB APP ROUTER, AUTHENTICATION & DATA LOADING ---

/**
 * Main entry point for all web apps.
 * UPDATED to handle Tax Certificate Approval actions and route admins.
 */
function doGet(e) {
  // --- NEW: Handle Tax Certificate Approval/Rejection Actions ---
  // This allows the Accountant to click the email button without logging into the session
  if (e.parameter.action && e.parameter.dv) {
    return handleTaxCertAction(e.parameter.action, e.parameter.dv);
  }

  // --- EXISTING: Session Management & Routing ---
  try {
    const token = e.parameter.token;
    if (token) {
      const isBlocklisted = CacheService.getScriptCache().get(`blocklist_${token}`);
      if (isBlocklisted) {
        return HtmlService.createHtmlOutputFromFile('Login').setTitle('DAP E-Payment System - Login');
      }

      const session = CacheService.getScriptCache().get(`session_${token}`);
      if (session) {
        const [email, role, isAdminView] = session.split(':');
        
        if (role === 'Admin' && isAdminView === 'true') {
          return HtmlService.createHtmlOutputFromFile('AdminWebApp').setTitle('DAP E-Payment - Admin Dashboard');
        } else if (role === 'Treasury' || role === 'Admin') {
          return HtmlService.createHtmlOutputFromFile('TreasuryHub').setTitle('DAP Treasury Hub');
        } else if (role === 'Accounting') {
          return HtmlService.createHtmlOutputFromFile('AccountingWebApp').setTitle('DAP E-Payment Upload');
        }
      }
    }
    return HtmlService.createHtmlOutputFromFile('Login').setTitle('DAP E-Payment System - Login');
  } catch (error) {
    Logger.log(error);
    return HtmlService.createHtmlOutput("<p>An unexpected error occurred. Please try again later.</p>");
  }
}


/**
 * Handles user login requests from the Login page.
 * INTEGRATED with the Admin Dashboard login preference.
 */
function loginUser(email, password, isAdminView) {
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('User_Database');

    if (!sheet) {
      throw new Error("Critical Error: The 'User_Database' sheet could not be found. Please check the sheet name.");
    }

    const data = sheet.getDataRange().getValues();
    const headers = data.shift();
    const emailCol = headers.indexOf('Email Address');
    const hashCol = headers.indexOf('Password Hash');
    const saltCol = headers.indexOf('Salt');
    const roleCol = headers.indexOf('Role');
    const statusCol = headers.indexOf('Status');

    const userRow = data.find(row => row[emailCol] && row[emailCol].toLowerCase() === email.toLowerCase());

    if (!userRow) {
      return { success: false, message: "Login Failed: Invalid email or password." };
    }
    
    if (userRow[statusCol] !== 'Active') {
      return { success: false, message: "Login Failed: Your account is not active. Please contact an administrator." };
    }

    const storedHash = userRow[hashCol];
    const storedSalt = userRow[saltCol];
    
    if (!storedHash || !storedSalt) {
        return { success: false, message: "Login Failed: Password has not been set for this account." };
    }

    const inputHash = _hashPassword(password, storedSalt);

    if (inputHash === storedHash) {
      const sessionToken = Utilities.getUuid();
      const role = userRow[roleCol];

      // --- NEW: Store the isAdminView preference in the session ---
      const sessionValue = `${email}:${role}:${isAdminView}`;
      CacheService.getScriptCache().put(`session_${sessionToken}`, sessionValue, 28800);
      
      const appUrl = ScriptApp.getService().getUrl();
      const redirectUrl = `${appUrl}?token=${sessionToken}`;
      
      return { success: true, message: "Login successful! Redirecting...", redirectUrl: redirectUrl };
    } else {
      return { success: false, message: "Login Failed: Invalid email or password." };
    }
  } catch (e) {
    Logger.log(`Login Error: ${e.message}`);
    return { success: false, message: e.message };
  }
}

/**
 * Logs a user out by destroying their session AND adding their token to a temporary blocklist.
 */
function logoutUser(token) {
  if (token) {
    CacheService.getScriptCache().remove(`session_${token}`);
    CacheService.getScriptCache().put(`blocklist_${token}`, 'invalidated', 300); // Block for 5 minutes
  }
}

/**
 * Fetches all the necessary data for the Treasury web app on initial load.
 * This is the stable version that loads all data at once.
 */
function getInitialDataForTreasuryWebApp() {
  const masterSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Master_DV_List');
  const data = masterSheet.getDataRange().getValues();
  const headers = data.shift();

  const forBatching = [];
  const inProcess = {};
  const completed = {};
  
  const statusCol = headers.indexOf('Status');
  const payeeNameCol = headers.indexOf('Payee Name');
  const dvNoCol = headers.indexOf('DV No');
  const amountCol = headers.indexOf('Amount Due');
  const transTypeCol = headers.indexOf('Transaction Type');
  const batchNoCol = headers.indexOf('Batch No');
  const transferRemarksCol = headers.indexOf('Transfer Remarks');

  for (const row of data) {
    try {
      const status = row[statusCol];
      const batchNo = row[batchNoCol];
      const amount = parseFloat(row[amountCol]) || 0;

      const transaction = {
          payeeName: row[payeeNameCol],
          dvNo: row[dvNoCol],
          amount: amount,
          transType: row[transTypeCol],
          transferRemarks: transferRemarksCol > -1 ? row[transferRemarksCol] : ''
      };

      if (status === 'For Processing') {
        forBatching.push(transaction);
      } else if (status && status !== 'Completed' && batchNo) {
          if (!inProcess[batchNo]) {
              inProcess[batchNo] = { status: status, totalAmount: 0, transactions: [] };
          }
          inProcess[batchNo].totalAmount += transaction.amount;
          inProcess[batchNo].transactions.push(transaction);
      } else if (status === 'Completed' && batchNo) {
          if (!completed[batchNo]) {
              completed[batchNo] = { status: status, totalAmount: 0, transactions: [] };
          }
          completed[batchNo].totalAmount += transaction.amount;
          completed[batchNo].transactions.push(transaction);
      }
    } catch(e) {
      Logger.log(`Error processing row: ${row}. Error: ${e.message}`);
    }
  }

  // Add file links to the batches
  for (const batchNo in inProcess) { 
    addFileLinksToBatch(batchNo, inProcess[batchNo]); 
  }
  for (const batchNo in completed) { 
    addFileLinksToBatch(batchNo, completed[batchNo]); 
  }

  return { forBatching, inProcess, completed };
}

/**
 * Helper function to find and add document links to a batch object.
 * This function is called by getInitialDataForTreasuryWebApp.
 */
function addFileLinksToBatch(batchNo, batchObject) {
    try {
        const batchFolder = getBatchFolder(batchNo);
        const findesFile = batchFolder.getFilesByName(`FINDES-${batchNo}.csv`);
        const annexHFile = batchFolder.getFilesByName(`Annex H - ${batchNo}.pdf`);
        
        if (findesFile.hasNext()) {
            batchObject.findesLink = findesFile.next().getUrl();
        }
        if (annexHFile.hasNext()) {
            batchObject.annexHLink = annexHFile.next().getUrl();
        }
    } catch(e) {
        Logger.log(`Could not find folder for batch ${batchNo} to add file links.`);
    }
}



/**
 * Creates a custom menu for Treasury users.
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('E-Payment Actions (Treasury)')
    .addItem('3. Create Batch from Selection', 'createBatch') // Now starts at Stage 3
    .addSeparator()
    .addItem('4. Generate FINDES File for Batch', 'generateFindesFile')
    .addItem('4a. Request Endorsement', 'showEndorsementDialog')
    .addSeparator()
    .addItem('5. Process Approved Batch (Annex H & Emails)', 'showFinalizeDialog')
    .addSeparator()
    .addItem('6. Notify Accounting of Processed Batch', 'showAccountingNotificationDialog')
    .addToUi();
}
/**
 * Displays an HTML dialog for file uploading.
 */
function showUploadDialog() {
  const html = HtmlService.createHtmlOutputFromFile('uploadDialog')
    .setWidth(400)
    .setHeight(200);
  SpreadsheetApp.getUi().showModalDialog(html, 'Upload Disbursement Voucher PDF');
}


/**
 * A simple function to test if the Drive API service is enabled.
 */
function testDriveApi() {
  try {
    // CORRECTED: Added 'fields' parameter to the API call.
    const about = Drive.About.get({ fields: "user" });
    SpreadsheetApp.getUi().alert('✅ Success! The Drive API is correctly enabled and running. User: ' + about.user.displayName);
  } catch (e) {
    SpreadsheetApp.getUi().alert('❌ Error: The Drive API is still not working. Error message: ' + e.message);
  }
}


/**
 * Creates a payment batch from selected rows in the master list.
 */
function createBatch() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(MASTER_LIST_SHEET_NAME);
  const dataRange = sheet.getRange('A2:O' + sheet.getLastRow()); // Range updated to O
  const data = dataRange.getValues();

  // Corrected column indexes
  const selectCol = 0; // Column A
  const statusCol = 1; // Column B
  const batchNoCol = 14; // Column O

  const now = new Date();
  const year = now.getFullYear();
  const month = ('0' + (now.getMonth() + 1)).slice(-2);

  const batchNumbersInSheet = sheet.getRange(2, batchNoCol + 1, sheet.getLastRow() - 1, 1).getValues()
    .flat()
    .filter(bn => bn && bn.startsWith(`${year}-${month}`));

  const lastSerial = batchNumbersInSheet.length > 0 ? Math.max(...batchNumbersInSheet.map(bn => parseInt(bn.split('-')[2]))) : 0;
  const newSerialNumber = ('000' + (lastSerial + 1)).slice(-4);
  const newBatchNumber = `${year}-${month}-${newSerialNumber}`;

  let selectedRowCount = 0;

  for (let i = 0; i < data.length; i++) {
    const isSelected = data[i][selectCol];
    const status = data[i][statusCol];

    if (isSelected && status === 'For Processing') {
      sheet.getRange(i + 2, statusCol + 1).setValue('Batched for Approval');
      sheet.getRange(i + 2, batchNoCol + 1).setValue(newBatchNumber);
      selectedRowCount++;
    }
  }

  if (selectedRowCount > 0) {
    sheet.getRange('A2:A' + sheet.getLastRow()).uncheck();
    SpreadsheetApp.getUi().alert(`Success! Batch "${newBatchNumber}" has been created with ${selectedRowCount} transaction(s).`);
  } else {
    SpreadsheetApp.getUi().alert('No transactions were selected or eligible for batching. Please check the boxes in the "Select" column for rows with "For Processing" status.');
  }
}
/**
 * Main function for Stage 4. Generates the FINDES file for a given batch.
 * UPDATED with Safety Check for short account numbers and Auto-Padding.
 */
function generateFindesFile() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt('Enter Batch Number', 'Please enter the batch number to process (e.g., 2025-07-001):', ui.ButtonSet.OK_CANCEL);

  if (response.getSelectedButton() !== ui.Button.OK || response.getResponseText() === '') {
    return;
  }

  const batchNo = response.getResponseText().trim();
  const masterSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Master_DV_List');
  const payeeDbSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Payee_Database');
  const payeeDbData = payeeDbSheet.getDataRange().getValues();
  const payeeMap = new Map(payeeDbData.map(row => [row[0], row[1]]));

  // Load the SDO PCF Accounts
  const sdoSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('SDO_PCF_Accounts');
  const sdoData = sdoSheet.getDataRange().getValues();
  const sdoAccountMap = new Map(sdoData.map(row => [row[0], row[1]]));

  let findesContent = '';
  let transactionCount = 0;
  const headers = masterSheet.getRange('A1:P1').getValues()[0];
  const payeeNameCol = headers.indexOf('Payee Name');
  const amountCol = headers.indexOf('Amount Due');
  const batchNoCol = headers.indexOf('Batch No');
  const statusCol = headers.indexOf('Status');
  const transTypeCol = headers.indexOf('Transaction Type');

  const allSheetData = masterSheet.getRange("A2:P" + masterSheet.getLastRow()).getValues();

  for (let i = 0; i < allSheetData.length; i++) {
    const row = allSheetData[i];
    if (row[batchNoCol] === batchNo) {
      const payeeName = row[payeeNameCol];
      const transactionType = row[transTypeCol];
      let accountNo;

      // "Smart" SDO Account Selection Logic
      if (transactionType === 'Replenishment of Petty Cash Funds' || transactionType === 'Establishment of Revolving Fund') {
        accountNo = sdoAccountMap.get(payeeName);
      }
      
      // Fallback to main payee database
      if (!accountNo) {
        accountNo = payeeMap.get(payeeName);
      }

      if (!accountNo) {
        ui.alert(`Error: A valid bank account could not be found for "${payeeName}". Please ensure they are enrolled correctly.`);
        return;
      }

      // --- NEW: Safety Check and Formatting ---
      const accountStr = accountNo.toString();

      // Safety Stop: If account is 7 digits or less (implies 3+ missing zeros or typo), stop and alert.
      if (accountStr.length <= 7) {
        ui.alert(`Error: Account number for "${payeeName}" is suspiciously short (${accountStr}). \n\nPlease verify this account in the Payee Database before proceeding.`);
        return;
      }

      // Safe Padding: Add leading zeros only if it's 8 or 9 digits to reach 10.
      const finalAccountNo = accountStr.padStart(10, '0');
      // --- END OF NEW LOGIC ---
      
      let cleanedName = payeeName;
      const firstCommaIndex = payeeName.indexOf(',');
      if (firstCommaIndex > -1) {
        const surnamePart = payeeName.substring(0, firstCommaIndex + 1);
        const restOfName = payeeName.substring(firstCommaIndex + 1);
        cleanedName = surnamePart + restOfName.replace(/[.,'-]/g, '');
      } else {
        cleanedName = payeeName.replace(/[.,'-]/g, '');
      }
      cleanedName = cleanedName.toUpperCase().replace(/Ñ/g, 'N').replace(/\s+/g, ' ').trim();
      
      const amount = row[amountCol];
      const formattedAmount = (amount * 100).toFixed(0);

      findesContent += `"${finalAccountNo}","${cleanedName}",${formattedAmount}\n`;
      transactionCount++;
    }
  }

  if (transactionCount === 0) {
    ui.alert(`No transactions found for batch number "${batchNo}".`);
    return;
  }

  saveFindesFile(findesContent, batchNo);

  // Update status after successful file generation
  for (let i = 0; i < allSheetData.length; i++) {
    if (allSheetData[i][batchNoCol] === batchNo) {
      masterSheet.getRange(i + 2, statusCol + 1).setValue('FINDES Generated');
    }
  }
  
  ui.alert(`FINDES file for batch "${batchNo}" has been generated and saved. Status updated.`);
}

/**
 * Saves the FINDES CSV content to the correct batch folder in Google Drive.
 * @param {string} content The CSV data.
 * @param {string} batchNo The batch number for naming and folder structure.
 */
function saveFindesFile(content, batchNo) {
  const config = getConfiguration();
  const rootFolder = DriveApp.getFolderById(config.processedFolderId);

  const year = batchNo.split('-')[0];
  const monthNum = batchNo.split('-')[1];
  const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const monthName = monthNames[parseInt(monthNum, 10) - 1];

  // Get or create Year folder
  let yearFolder = rootFolder.getFoldersByName(year);
  yearFolder = yearFolder.hasNext() ? yearFolder.next() : rootFolder.createFolder(year);

  // Get or create Month folder
  let monthFolder = yearFolder.getFoldersByName(`${monthNum}-${monthName}`);
  monthFolder = monthFolder.hasNext() ? monthFolder.next() : yearFolder.createFolder(`${monthNum}-${monthName}`);

  // Get or create Batch folder
  const batchFolderName = `BATCH-${batchNo}`;
  let batchFolder = monthFolder.getFoldersByName(batchFolderName);
  batchFolder = batchFolder.hasNext() ? batchFolder.next() : monthFolder.createFolder(batchFolderName);

  const fileName = `FINDES-${batchNo}.csv`;
  batchFolder.createFile(fileName, content, MimeType.CSV);
}


/**
 * Shows the dialog for requesting endorsement.
 */
function showEndorsementDialog() {
  const html = HtmlService.createHtmlOutputFromFile('endorsementDialog')
    .setWidth(400)
    .setHeight(250);
  SpreadsheetApp.getUi().showModalDialog(html, 'Request Endorsement for Batch');
}

/**
 * Gathers batch details, saves the WeAccess TRN, sends a detailed endorsement email to authorizers,
 * moves DV PDFs to the batch folder, and updates transaction statuses.
 */
function requestEndorsement(dataObject) {
    const { batchNo, weaccessRef, payrollFile } = dataObject;
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Master_DV_List');
    const dataRange = sheet.getRange('A2:P' + sheet.getLastRow());
    const allData = dataRange.getValues();
    const headers = sheet.getRange('A1:P1').getValues()[0];

    const payrollBlob = Utilities.newBlob(Utilities.base64Decode(payrollFile.bytes), payrollFile.mimeType, payrollFile.name);
    const batchFolder = getBatchFolder(batchNo);
    batchFolder.createFile(payrollBlob);

    const attachments = [payrollBlob];
    const batchTransactions = [];
    let totalAmount = 0;
    let failedAttachments = [];

    const statusCol = headers.indexOf('Status');
    const batchNoCol = headers.indexOf('Batch No');
    const refNoCol = headers.indexOf('WeAccess Ref No');
    const payeeNameCol = headers.indexOf('Payee Name');
    const transTypeCol = headers.indexOf('Transaction Type');
    const amountCol = headers.indexOf('Amount Due');
    const dvNoCol = headers.indexOf('DV No');
    const pdfLinkCol = headers.indexOf('PDF_Link');

    for (let i = 0; i < allData.length; i++) {
        const row = allData[i];
        if (row[batchNoCol] && row[batchNoCol].toString() === batchNo.toString()) {
            const dvNumber = row[dvNoCol];
            const transactionDetails = {
                payee: row[payeeNameCol],
                type: row[transTypeCol],
                amount: row[amountCol],
                dv: dvNumber
            };
            batchTransactions.push(transactionDetails);
            totalAmount += transactionDetails.amount;

            try {
                const fileUrl = row[pdfLinkCol];
                let fileId = null;
                if (fileUrl && typeof fileUrl === 'string') {
                    const match = fileUrl.match(/\/d\/(.+?)\//) || fileUrl.match(/id=([^&]+)/);
                    if (match) {
                        fileId = match[1];
                    }
                }
                if (fileId) {
                    const file = DriveApp.getFileById(fileId);
                    attachments.push(file.getBlob());
                    file.moveTo(batchFolder);
                } else {
                    failedAttachments.push(dvNumber);
                }
            } catch (e) {
                failedAttachments.push(dvNumber);
                console.error(`Could not process file for DV ${dvNumber}: ${e.message}`);
            }
            
            sheet.getRange(i + 2, statusCol + 1).setValue('Pending WeAccess Approval');
            sheet.getRange(i + 2, refNoCol + 1).setValue(weaccessRef);
        }
    }

    if (batchTransactions.length > 0) {
    const recipient = 'madriagal@dap.edu.ph,gudoyj@dap.edu.ph,barawidana@dap.edu.ph,dogeliop@dap.edu.ph,calinal@dap.edu.ph' ; // Replace with actual authorizer emails
    const ccrecipient = 'mendozas@dap.edu.ph,nolascom@dap.edu.ph,set@dap.edu.ph,medinor@dap.edu.ph,tomolingj@dap.edu.ph';
    const bccrecipient = 'cashtreasury@dap.edu.ph,anchetad@dap.edu.ph'
    const subject = `For WeAccess Approval: E-Payment Batch ${batchNo}`;
        
        let htmlBody = `
          <div style="font-family: Arial, sans-serif; font-size: 16px; color: #333; max-width: 600px; margin: auto; border: 1px solid #ddd;">
            <div style="background-color: #1C2790; padding: 20px; text-align: center;">
              <img src="https://i.imgur.com/jaEbfAR.png" alt="DAP Logo" style="width: 400px;">
            </div>
            <div style="padding: 25px; border-top: 5px solid #CDAE2C;">
              <h2 style="color: #1C2790;">Request for WeAccess Approval</h2>
              <p>Dear Authorizers,</p>
              <p>This is a request for your approval of the e-payment batch with the following details:</p>
              
              <table style="width: 100%; border-collapse: collapse; margin-top: 25px; margin-bottom: 25px; text-align: left;">
                <tr style="background-color: #f2f2f2;"><td style="padding: 12px; border: 1px solid #ddd; font-weight: bold;">Batch Number:</td><td style="padding: 12px; border: 1px solid #ddd; font-weight: bold; font-size: 1.1em; color: #1C2790;">${batchNo}</td></tr>
                <tr><td style="padding: 12px; border: 1px solid #ddd; font-weight: bold;">WeAccess TRN:</td><td style="padding: 12px; border: 1px solid #ddd;">${weaccessRef}</td></tr>
                <tr><td style="padding: 12px; border: 1px solid #ddd; font-weight: bold;">Total Records:</td><td style="padding: 12px; border: 1px solid #ddd;">${batchTransactions.length}</td></tr>
                <tr><td style="padding: 12px; border: 1px solid #ddd; font-weight: bold;">Total Amount:</td><td style="padding: 12px; border: 1px solid #ddd;">PHP ${totalAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td></tr>
              </table>
              
              <p style="text-align: center; margin: 30px 0;">
                <a href="https://www.lbpweaccess.com/" target="_blank" style="background-color: #CDAE2C; color: #1C2790; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold; font-size: 16px;">Login to WeAccess</a>
              </p>

              <div style="border-top: 1px solid #eee; margin-top: 20px; padding-top: 20px;">
                <h3 style="color: #1C2790; margin-top: 0;">Instructions for Approval:</h3>
                <ol style="padding-left: 20px; line-height: 1.6;">
                  <li>Click the button above to log in to the WeAccess portal.</li>
                  <li>Navigate to <b>"Institutional Services"</b>, then click on <b>"ATM Payroll"</b>.</li>
                  <li>Find the transaction matching the TRN and Batch details above to approve.</li>
                </ol>
              </div>

              <p><b>Breakdown Summary:</b></p>
              <table border="1" cellpadding="5" cellspacing="0" style="width: 100%; border-collapse: collapse;">
                <thead style="background-color: #f2f2f2;">
                  <tr>
                    <th style="padding: 8px; border: 1px solid #ddd; text-align: left;">#</th>
                    <th style="padding: 8px; border: 1px solid #ddd; text-align: left;">Payee Name</th>
                    <th style="padding: 8px; border: 1px solid #ddd; text-align: left;">Transaction Type</th>
                    <th style="padding: 8px; border: 1px solid #ddd; text-align: right;">Amount</th>
                  </tr>
                </thead>
                <tbody>`;

        let counter = 1;
        for (const trans of batchTransactions) {
            htmlBody += `
                  <tr>
                    <td style="padding: 8px; border: 1px solid #ddd;">${counter++}</td>
                    <td style="padding: 8px; border: 1px solid #ddd;">${trans.payee}</td>
                    <td style="padding: 8px; border: 1px solid #ddd;">${trans.type}</td>
                    <td style="padding: 8px; border: 1px solid #ddd; text-align: right;">${trans.amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                  </tr>`;
        }

        htmlBody += `
                </tbody>
                <tfoot style="font-weight: bold;">
                  <tr>
                    <td colspan="3" style="padding: 8px; border: 1px solid #ddd; text-align: right;">Total Transactions in this Batch:</td>
                    <td style="padding: 8px; border: 1px solid #ddd; text-align: right;">${batchTransactions.length}</td>
                  </tr>
                  <tr>
                    <td colspan="3" style="padding: 8px; border: 1px solid #ddd; text-align: right;">Total Amount:</td>
                    <td style="padding: 8px; border: 1px solid #ddd; text-align: right;">${totalAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                  </tr>
                </tfoot>
              </table>
              <p style="margin-top: 25px;">The WeAccess Payroll Register and all supporting Disbursement Vouchers are attached to this email for your review.</p>`;
        
        if(failedAttachments.length > 0) {
            htmlBody += `<p style="color: red;"><b>Warning:</b> Could not attach or move the DV PDFs for the following DV numbers: ${failedAttachments.join(', ')}.</p>`;
        }
        
        htmlBody += `
            </div>
            <div style="text-align: center; font-size: 12px; color: #777; padding: 15px; background-color: #f9f9f9; border-top: 1px solid #ddd;"><p>This is an automated notification from the DAP E-Payment System.</p></div>
          </div>
        `;

        MailApp.sendEmail({
            to: recipient,
            cc: ccrecipient,
            bcc: bccrecipient,
            subject: subject,
            htmlBody: htmlBody,
            attachments: attachments,
            name: 'DAP E-Payment System'
        });

        return { success: true, message: `Success! Endorsement request for batch "${batchNo}" has been sent.` };
    } else {
        throw new Error(`No transactions found for batch "${batchNo}".`);
    }
}
/**
 * Finds and returns the Google Drive folder for a specific batch.
 * Creates the folder structure (Year/Month/Batch) if it doesn't exist.
 * @param {string} batchNo The batch number.
 * @return {GoogleAppsScript.Drive.Folder} The batch folder object.
 */
function getBatchFolder(batchNo) {
  const config = getConfiguration();
  const rootFolder = DriveApp.getFolderById(config.processedFolderId);

  const year = batchNo.split('-')[0];
  const monthNum = batchNo.split('-')[1];
  const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const monthName = monthNames[parseInt(monthNum, 10) - 1];

  // Get or create Year folder
  let yearFolder = rootFolder.getFoldersByName(year);
  yearFolder = yearFolder.hasNext() ? yearFolder.next() : rootFolder.createFolder(year);

  // Get or create Month folder
  let monthFolder = yearFolder.getFoldersByName(`${monthNum}-${monthName}`);
  monthFolder = monthFolder.hasNext() ? monthFolder.next() : yearFolder.createFolder(`${monthNum}-${monthName}`);

  // Get or create Batch folder
  const batchFolderName = `BATCH-${batchNo}`;
  let batchFolder = monthFolder.getFoldersByName(batchFolderName);
  batchFolder = batchFolder.hasNext() ? batchFolder.next() : monthFolder.createFolder(batchFolderName);
  
  return batchFolder;
}

// --- STAGE 5 FUNCTIONS ---

/**
 * Shows the dialog for finalizing a batch.
 */
function showFinalizeDialog() {
  const html = HtmlService.createHtmlOutputFromFile('finalizeDialog')
    .setWidth(400)
    .setHeight(300);
  SpreadsheetApp.getUi().showModalDialog(html, 'Finalize Approved Batch');
}

/**
 * Generates the Annex H report as a PDF, dynamically inserting rows
 * and finding the 'TOTAL' cell to place the final sum.
 * Unsuccessful transfers (failuresByDv: DV No -> bank remarks) are listed in red with the
 * bank's reason, left out of TOTAL, and explained in a reconciliation block under it.
 */
function generateAnnexH(batchNo, weaccessRef, batchFolder, failuresByDv = new Map()) {
  const masterSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Master_DV_List');
  const masterData = masterSheet.getDataRange().getValues();
  const headers = masterData.shift();

  const templateFile = DriveApp.getFileById('1sRiGPfogikW8wfmU3-ThKCzvYE3wlaY7NlXfgsROkbQ'); 
  
  // --- CORRECTED ORDER ---
  // The variable must be declared before it is used.
  const newFileName = `Annex H - ${batchNo}`;
  const newFile = templateFile.makeCopy(newFileName, batchFolder);
  
  const reportSheet = SpreadsheetApp.openById(newFile.getId()).getSheets()[0];
  const reportDate = new Date();

  // Populate header cells
  reportSheet.getRange('B3').setValue(reportDate).setNumberFormat('mm/dd/yyyy');
  reportSheet.getRange('I3').setValue(batchNo);

  // Prepare data rows
  let totalAmount = 0;
  const reportRows = [];
  const batchDateStr = reportDate.toLocaleDateString('en-US');
  
  const payeeNameCol = headers.indexOf('Payee Name');
  const dvNoCol = headers.indexOf('DV No');
  const busNoCol = headers.indexOf('BUS No');
  const projectCodeCol = headers.indexOf('Project Code');
  const transTypeCol = headers.indexOf('Transaction Type');
  const amountCol = headers.indexOf('Amount Due');
  const batchNoColData = headers.indexOf('Batch No');

  let registerTotal = 0;
  const failedRowOffsets = [];

  for (const row of masterData) {
    if (row[batchNoColData] === batchNo) {
      const amount = row[amountCol];
      const failReason = failuresByDv.get(row[dvNoCol].toString());
      const isFailed = failReason !== undefined;
      reportRows.push([
        batchDateStr, "N/A", weaccessRef, row[payeeNameCol], row[dvNoCol],
        row[busNoCol], row[projectCodeCol],
        isFailed ? `UNSUCCESSFUL - ${failReason}` : row[transTypeCol],
        amount
      ]);
      registerTotal += amount;
      if (isFailed) {
        failedRowOffsets.push(reportRows.length - 1);
      } else {
        totalAmount += amount;
      }
    }
  }
  totalAmount = Math.round(totalAmount * 100) / 100;
  registerTotal = Math.round(registerTotal * 100) / 100;

  if (reportRows.length > 0) {
    const dataStartRow = 7;
    if (reportRows.length > 1) {
        reportSheet.insertRowsBefore(dataStartRow + 1, reportRows.length - 1);
    }

    reportSheet.getRange(dataStartRow, 1, reportRows.length, 9).setValues(reportRows);

    // Unsuccessful transfers: whole row in red; amount shown but excluded from TOTAL.
    for (const offset of failedRowOffsets) {
        reportSheet.getRange(dataStartRow + offset, 1, 1, 9).setFontColor('#C00000');
        reportSheet.getRange(dataStartRow + offset, 8).setWrap(true);
    }

    const hColumnValues = reportSheet.getRange("H:H").getValues();
    let totalRowIndex = -1;
    for (let i = 0; i < hColumnValues.length; i++) {
        if (hColumnValues[i][0].toString().toUpperCase().trim() === 'TOTAL') {
            totalRowIndex = i;
            break;
        }
    }

    if (totalRowIndex > -1) {
        const totalCell = reportSheet.getRange(totalRowIndex + 1, 9); // Column I
        totalCell.setValue(totalAmount).setNumberFormat('#,##0.00');

        if (failedRowOffsets.length > 0) {
            // Reconciliation: register / debit memo (full batch) less unsuccessful = bank statement (net).
            const totalRow = totalRowIndex + 1;
            reportSheet.insertRowsAfter(totalRow, 4);
            reportSheet.getRange(totalRow + 1, 1, 4, 9).clearFormat().setFontFamily('Arial').setFontSize(11);
            const lines = [
                ['Total per Payroll Register / Debit Memo', registerTotal],
                [`Less: Unsuccessful transfers (${failedRowOffsets.length})`, -(Math.round((registerTotal - totalAmount) * 100) / 100)],
                ['Total e-payments (per bank statement)', totalAmount]
            ];
            lines.forEach(([label, value], k) => {
                const r = totalRow + 2 + k;
                const weight = k === lines.length - 1 ? 'bold' : 'normal';
                reportSheet.getRange(r, 4, 1, 5).merge().setValue(label)
                    .setHorizontalAlignment('right').setFontWeight(weight);
                reportSheet.getRange(r, 9).setValue(value)
                    .setNumberFormat('#,##0.00;(#,##0.00)').setFontWeight(weight);
            });
        }
    }
  }
  
  // Finalize and save as PDF
  SpreadsheetApp.flush();
  const pdfBlob = newFile.getAs('application/pdf');
  batchFolder.createFile(pdfBlob).setName(newFileName + '.pdf');
  DriveApp.getFileById(newFile.getId()).setTrashed(true);
}

/**
 * Updates the status of transactions in a finalized batch.
 * This version no longer handles the WeAccess Ref No.
 */
function updateStatusAndArchiveDvs(batchNo) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Master_DV_List');
  const dataRange = sheet.getRange('A2:P' + sheet.getLastRow());
  const data = dataRange.getValues();
  
  const headers = sheet.getRange('A1:P1').getValues()[0];
  const statusCol = headers.indexOf('Status');
  const batchNoCol = headers.indexOf('Batch No');

  for (let i = 0; i < data.length; i++) {
    if (data[i][batchNoCol] === batchNo) {
      sheet.getRange(i + 2, statusCol + 1).setValue('Approved & Emailed');
    }
  }
}
/**
 * Sends individual email notifications to payees in a batch.
 * UPDATED to bundle Tax Certificates if available.
 */
function sendPayeeEmails(batchNo) {
    const masterSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Master_DV_List');
    const masterData = masterSheet.getDataRange().getValues();
    const headers = masterData.shift();

    const payeeDbSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Payee_Database');
    const payeeDbData = payeeDbSheet.getDataRange().getValues();
    const emailMap = new Map(payeeDbData.map(row => [row[0], row[2]]));
    const accountMap = new Map(payeeDbData.map(row => [row[0], row[1]]));

    const payeeNameCol = headers.indexOf('Payee Name');
    const amountCol = headers.indexOf('Amount Due');
    const dvNoCol = headers.indexOf('DV No');
    const batchNoCol = headers.indexOf('Batch No');
    const transTypeCol = headers.indexOf('Transaction Type');
    const pdfLinkCol = headers.indexOf('PDF_Link');
    const timestampCol = headers.indexOf('Payment Timestamp');
    
    // --- NEW: Check for Tax Cert Link column ---
    const taxCertCol = headers.indexOf('Tax Cert Link');

    for (const row of masterData) {
        if (row[batchNoCol] && row[batchNoCol].toString() === batchNo.toString()) {
            const payeeName = row[payeeNameCol];
            const email = emailMap.get(payeeName);

            if (email) {
                const amountValue = row[amountCol];
                const formattedAmount = amountValue.toLocaleString('en-US', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2
                });
                const dvNo = row[dvNoCol];
                const transactionType = row[transTypeCol];

                const fullAccountNo = accountMap.get(payeeName) || "XXXX";
                const lastFourDigits = fullAccountNo.toString().slice(-4);

                // One subject per batch so every confirmation (and the BCC copies) lands in a single thread.
                const subject = `DAP Fund Transfer Confirmation (Batch ${batchNo})`;

                let htmlBody = `
                    <div style="font-family: Arial, sans-serif; font-size: 16px; color: #333; max-width: 600px; margin: auto; border: 1px solid #ddd;">
                        <div style="background-color: #1C2790; padding: 20px; text-align: center;">
                            <img src="https://i.imgur.com/jaEbfAR.png" alt="DAP Logo" style="width: 400px;">
                        </div>
                        <div style="padding: 25px; border-top: 5px solid #CDAE2C;">
                            <h2 style="color: #1C2790; text-align: center; font-size: 24px; text-transform: uppercase;">FUND TRANSFER CONFIRMATION</h2>
                            <p>Dear <b>${payeeName}</b>,</p>
                            <p>This is to inform you that an electronic payment (e-payment) has been credited to your Landbank account ending in <b>${lastFourDigits}</b>. Please find the details of your transaction below.</p>
                            <table style="width: 100%; border-collapse: collapse; margin-top: 25px; margin-bottom: 25px;">
                                <tr style="background-color: #f2f2f2;"><td style="padding: 12px; border: 1px solid #ddd; font-weight: bold;">Amount:</td><td style="padding: 12px; border: 1px solid #ddd; font-weight: bold; font-size: 1.1em; color: #1C2790;">PHP ${formattedAmount}</td></tr>
                                <tr><td style="padding: 12px; border: 1px solid #ddd; font-weight: bold;">Payment For:</td><td style="padding: 12px; border: 1px solid #ddd;">${transactionType}</td></tr>
                                <tr><td style="padding: 12px; border: 1px solid #ddd; font-weight: bold;">DV Number:</td><td style="padding: 12px; border: 1px solid #ddd;">${dvNo}</td></tr>
                            </table>
                            <p>The corresponding Disbursement Voucher PDF is attached for your reference.</p>
                            <p style="font-weight: bold;">Please verify with your LandBank iAccess Account if fund transfer has been successfully completed. If not, please immediately notify the Treasury Division by replying to this email, or call local 136.</p>
                        `;

                if (transactionType === 'Cash Advance for Specific Purposes' || transactionType === 'Cash Advance for Travel') {
                    htmlBody += `
                        <div style="border-top: 2px solid #CDAE2C; margin-top: 30px; padding-top: 20px; background-color: #f9f9f9; padding: 20px; border-radius: 5px;">
                            <h3 style="color: #1C2790; margin-top: 0; text-align: center;">How was your e-payment experience?</h3>
                            <p style="text-align: center; font-size: 15px;">We're always working to make our services faster and more convenient. If you had a smooth experience processing your cash advance, we would love for you to share your feedback.</p>
                            <p style="text-align: center; margin-top: 20px; margin-bottom: 20px;">
                                <a href="https://tinyurl.com/DAPCSMSurvey" target="_blank" style="background-color: #CDAE2C; color: #1C2790; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold; font-size: 16px;">Share Your Experience (1-Min Survey)</a>
                            </p>
                            <p style="font-size: 14px; color: #555; text-align: center;">On the survey form, please select:<br><b>Finance Department &rarr; Request for Cash Advance &rarr;</b> and then choose the appropriate type.</p>
                        </div>
                    `;
                } else if (transactionType === 'Professional Fee - Consultancy Services' || transactionType === 'Professional Fee - Resource Person') {
                    htmlBody += `
                        <div style="border-top: 2px solid #CDAE2C; margin-top: 30px; padding-top: 20px; background-color: #f9f9f9; padding: 20px; border-radius: 5px;">
                            <h3 style="color: #1C2790; margin-top: 0; text-align: center;">How was your e-payment experience?</h3>
                            <p style="text-align: center; font-size: 15px;">Your feedback helps us improve our services. If you had a smooth experience receiving your professional fee, please share your thoughts.</p>
                            <p style="text-align: center; margin-top: 20px; margin-bottom: 20px;">
                                <a href="https://tinyurl.com/DAPCSMSurvey" target="_blank" style="background-color: #CDAE2C; color: #1C2790; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold; font-size: 16px;">Share Your Experience (1-Min Survey)</a>
                            </p>
                            <p style="font-size: 14px; color: #555; text-align: center;">On the survey form, please select:<br><b>DAP External Client &rarr; Finance Department &rarr; <mark>Request for Payment of Honoraria Services</mark></b></p>
                        </div>
                    `;
                }

                htmlBody += `
                    <p style="margin-top: 30px;">Thank you,</p><p><b>Finance Department</b></p>
                    </div>
                    <div style="text-align: center; font-size: 12px; color: #777; padding: 15px; background-color: #f9f9f9; border-top: 1px solid #ddd;"><p>This is an automated notification. Your reply will be sent to the Treasury Division.</p></div>
                    </div>
                `;

                const emailOptions = {
                    to: email,
                    bcc: 'balcen@dap.edu.ph,anchetad@dap.edu.ph',
                    subject: subject,
                    htmlBody: htmlBody,
                    name: 'DAP E-Payment System',
                    replyTo: 'cashtreasury@dap.edu.ph',
                    attachments: [] // Initialize empty array
                };

                try {
                    // 1. Attach DV PDF
                    const pdfLink = row[pdfLinkCol];
                    if (pdfLink && typeof pdfLink === 'string') {
                        const match = pdfLink.match(/\/d\/(.+?)\//) || pdfLink.match(/id=([^&]+)/);
                        if (match) {
                            const fileId = match[1];
                            const pdfBlob = DriveApp.getFileById(fileId).getBlob();
                            emailOptions.attachments.push(pdfBlob);
                        }
                    }

                    // 2. Attach Tax Cert PDF (If available and bundling is needed)
                    if (taxCertCol > -1) {
                        const taxLink = row[taxCertCol];
                        if (taxLink && typeof taxLink === 'string' && taxLink.length > 5) {
                            const taxMatch = taxLink.match(/\/d\/(.+?)\//) || taxLink.match(/id=([^&]+)/);
                            if (taxMatch) {
                                const taxFileId = taxMatch[1];
                                const taxBlob = DriveApp.getFileById(taxFileId).getBlob();
                                emailOptions.attachments.push(taxBlob);
                            }
                        }
                    }

                } catch (e) {
                    console.error(`Attachment Error for ${payeeName} (DV No. ${dvNo}): ${e.message}`);
                }

                MailApp.sendEmail(emailOptions);
            }
        }
    }
}

// --- STAGE 6 FUNCTIONS ---

/**
 * Shows a dialog to get the batch number for the accounting notification.
 */
function showAccountingNotificationDialog() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt('Notify Accounting', 'Enter the batch number to finalize and send to Accounting:', ui.ButtonSet.OK_CANCEL);
  
  if (response.getSelectedButton() === ui.Button.OK && response.getResponseText() !== '') {
    notifyAccounting(response.getResponseText().trim());
  }
}

/**
 * Generates a summary and emails all pertinent files to the Accounting Division.
 * UPDATED to remove UI elements and return a status object.
 */
function notifyAccounting(batchNo) {
  // We remove the ui variable since we can't use it here.
  const masterSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Master_DV_List');
  const masterData = masterSheet.getDataRange().getValues();
  const headers = masterData.shift();

  const batchNoCol = headers.indexOf('Batch No');
  const statusCol = headers.indexOf('Status');
  let batchStatus = '';
  for (const row of masterData) {
      if (row[batchNoCol] === batchNo) {
          batchStatus = row[statusCol];
          break;
      }
  }

  if (batchStatus !== 'Approved & Emailed') {
      // Return an error message instead of showing an alert
      return { success: false, message: `Action stopped: Batch "${batchNo}" has not been finalized in Stage 5 yet.` };
  }

  const clientCodeSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Reference_Client_Codes');
  const clientCodeData = clientCodeSheet.getDataRange().getValues();
  const clientCodeMap = new Map(clientCodeData.map(row => [row[0], row[1]]));

  let batchTransactions = [];
  let weaccessRef = '';
  const refNoCol = headers.indexOf('WeAccess Ref No');

  for (const row of masterData) {
    if (row[batchNoCol] === batchNo) {
      batchTransactions.push(row);
      if (!weaccessRef) weaccessRef = row[refNoCol];
    }
  }

  const payeeNameCol = headers.indexOf('Payee Name');
  const amountCol = headers.indexOf('Amount Due');
  const dvNoCol = headers.indexOf('DV No');
  let csvContent = "Batch Number,WeAccess Ref No,Payee Name,Client Code,Amount\n";
  let totalAmount = 0;
  for (const row of batchTransactions) {
    const payeeName = row[payeeNameCol];
    const clientCode = clientCodeMap.get(payeeName) || 'NOT FOUND';
    csvContent += `${batchNo},${weaccessRef},"${payeeName}",${clientCode},${row[amountCol]}\n`;
    totalAmount += parseFloat(row[amountCol]) || 0;
  }
  const csvBlob = Utilities.newBlob(csvContent, MimeType.CSV, `Accounting Summary - ${batchNo}.csv`);

  const reportDate = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' });
  const jevParticulars = `Daily Report of E-Payments from Agency Account - Report No. ${batchNo} with TRN#${weaccessRef} dtd ${reportDate}`;

  const props = PropertiesService.getScriptProperties();
  const failures = JSON.parse(props.getProperty(`UNSUCCESSFUL_${batchNo}`) || '[]');

  const batchFolder = getBatchFolder(batchNo);
  const attachments = [csvBlob].concat(_collectBatchAttachments(batchFolder, batchNo, masterData, headers));

  MailApp.sendEmail({
    to: ACCOUNTING_RECIPIENTS,
    subject: `For Recording: E-Payment Batch ${batchNo}`,
    htmlBody: _buildAccountingEmailHtml({
      batchNo: batchNo,
      weaccessRef: weaccessRef,
      successful: batchTransactions.map(row => ({ payeeName: row[payeeNameCol], dvNo: row[dvNoCol], amount: parseFloat(row[amountCol]) || 0 })),
      totalAmount: Math.round(totalAmount * 100) / 100,
      failures: failures,
      jevParticulars: jevParticulars,
      attachmentNames: attachments.map(b => b.getName())
    }),
    attachments: attachments,
    name: 'DAP E-Payment Notification (NO-REPLY)'
  });
  
  const allSheetData = masterSheet.getRange("A2:P" + masterSheet.getLastRow()).getValues();
  for (let i = 0; i < allSheetData.length; i++) {
    if (allSheetData[i][batchNoCol] === batchNo) {
      masterSheet.getRange(i + 2, statusCol + 1).setValue('Completed');
    }
  }
  props.deleteProperty(`UNSUCCESSFUL_${batchNo}`);
  
  // Return a success message instead of showing an alert
  return { success: true, message: `Success! Batch "${batchNo}" has been finalized and a notification has been sent to the Accounting Division.`};
}






/**
 * A simple function to test the web app's data loading process.
 */
function testWebAppLoader() {
  try {
    // We run the same function the web app calls.
    const data = getInitialDataForTreasuryWebApp();
    
    // If it works, we'll see a success message.
    Logger.log("Data loaded successfully.");
    Logger.log(JSON.stringify(data.forBatching.slice(0, 2))); // Log first 2 items to check format
    SpreadsheetApp.getUi().alert('✅ Success! The data loader is working correctly.');
    
  } catch (e) {
    // If it fails, this will show us the exact error message.
    Logger.log("Error during web app data loading: " + e.message);
    SpreadsheetApp.getUi().alert(`❌ An error occurred while loading the data: ${e.message}`);
  }
}

// --- USER AUTHENTICATION & SESSION MANAGEMENT ---

const USER_DB_SHEET = 'User_Database';
const SESSION_EXPIRATION_SECONDS = 28800; // 8 hours


/**
 * Handles user registration requests from the Login page.
 * @param {string} email The user's email address.
 * @param {string} password The user's chosen password.
 * @return {string} A success or error message.
 */
function registerUser(email, password) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(USER_DB_SHEET);
  const emailColumn = sheet.getRange("A:A").getValues();
  const existingUser = emailColumn.flat().find(e => e.toLowerCase() === email.toLowerCase());

  if (existingUser) {
    return "Error: This email address is already registered.";
  }

  const salt = Utilities.getUuid();
  const hash = _hashPassword(password, salt);

  sheet.appendRow([
    email,
    hash,
    salt,
    'Unassigned', // Default role
    'Pending Approval' // Default status
  ]);

  return "Success! Your account has been registered. Please wait for an administrator to approve your account.";
}


/**
 * Helper function to securely hash a password with a salt.
 * @param {string} password The plain-text password.
 * @param {string} salt The unique salt for the user.
 * @return {string} The resulting password hash.
 */
function _hashPassword(password, salt) {
  const saltedPassword = password + salt;
  const hashBytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, saltedPassword);
  // Convert the byte array to a hexadecimal string
  return hashBytes.map(byte => ('0' + (byte & 0xFF).toString(16)).slice(-2)).join('');
}

/**
 * An admin-only function to set or reset a user's password directly from the script editor.
 * This is useful for setting up the first admin account.
 */
function ADMIN_SET_USER_PASSWORD() {
  const ui = SpreadsheetApp.getUi();
  const emailResponse = ui.prompt("Admin: Set Password", "Enter the user's email address:", ui.ButtonSet.OK_CANCEL);
  if (emailResponse.getSelectedButton() !== ui.Button.OK) return;
  const email = emailResponse.getResponseText();

  const passwordResponse = ui.prompt("Admin: Set Password", `Enter the NEW password for ${email}:`, ui.ButtonSet.OK_CANCEL);
  if (passwordResponse.getSelectedButton() !== ui.Button.OK) return;
  const newPassword = passwordResponse.getResponseText();

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(USER_DB_SHEET);
  const data = sheet.getDataRange().getValues();
  const headers = data.shift();
  const emailCol = headers.indexOf('Email Address');
  const hashCol = headers.indexOf('Password Hash');
  const saltCol = headers.indexOf('Salt');
  
  const userRowIndex = data.findIndex(row => row[emailCol].toLowerCase() === email.toLowerCase());

  if (userRowIndex === -1) {
    ui.alert("Error: User not found.");
    return;
  }

  const salt = Utilities.getUuid();
  const hash = _hashPassword(newPassword, salt);

  sheet.getRange(userRowIndex + 2, saltCol + 1).setValue(salt);
  sheet.getRange(userRowIndex + 2, hashCol + 1).setValue(hash);

  ui.alert(`Password for ${email} has been set successfully.`);
}

/**
 * Archives completed rows older than 90 days to a new spreadsheet
 * and deletes them from the master list.
 */
function archiveOldData() {
  const masterSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Master_DV_List');
  if (masterSheet.getLastRow() < 2) {
    Logger.log("No data to archive.");
    return; // No data in the sheet
  }

  const dataRange = masterSheet.getDataRange();
  const allData = dataRange.getValues();
  const headers = allData.shift(); // Get headers and remove them from data

  const statusCol = headers.indexOf('Status');
  const timestampCol = headers.indexOf('Timestamp');

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - 30); // Set cutoff to 90 days ago

  const rowsToArchive = [];
  const rowNumbersToDelete = [];

  // Loop through data to find rows that meet the criteria
  for (let i = 0; i < allData.length; i++) {
    const row = allData[i];
    const status = row[statusCol];
    const timestamp = new Date(row[timestampCol]);

    if (status === 'Completed' && timestamp < cutoffDate) {
      rowsToArchive.push(row);
      // We add 2 because spreadsheet rows are 1-based and we removed the header
      rowNumbersToDelete.push(i + 2); 
    }
  }

  // Proceed only if there's something to archive
  if (rowsToArchive.length > 0) {
    const config = getConfiguration();
    const archiveFolder = DriveApp.getFolderById(config.archiveFolderId);
    
    // Create the new archive spreadsheet with a dynamic name
    const archiveFileName = `E-Payment Archive - ${new Date().toISOString().slice(0, 10)}`;
    const newArchiveSheet = SpreadsheetApp.create(archiveFileName);
    const archiveFile = DriveApp.getFileById(newArchiveSheet.getId());
    
    // Move the new archive file to the 'Archives' folder
    archiveFolder.addFile(archiveFile);
    DriveApp.getRootFolder().removeFile(archiveFile);
    
    // Write data to the archive
    const targetSheet = newArchiveSheet.getSheets()[0];
    targetSheet.appendRow(headers); // Add headers
    targetSheet.getRange(2, 1, rowsToArchive.length, headers.length).setValues(rowsToArchive);
    Logger.log(`${rowsToArchive.length} rows archived to ${archiveFileName}.`);

    // Delete the archived rows from the master sheet, starting from the bottom
    for (let i = rowNumbersToDelete.length - 1; i >= 0; i--) {
      masterSheet.deleteRow(rowNumbersToDelete[i]);
    }
    Logger.log(`${rowNumbersToDelete.length} rows deleted from Master_DV_List.`);
  } else {
    Logger.log("No old completed data found to archive.");
  }
}

/**
 * Reads a WeAccess Payroll Register PDF and extracts transaction data.
 * FIXED: Relaxed regex lookahead to capture the final transaction before totals/page breaks.
 */
function _parsePayrollRegisterPdf(pdfFile) {
  const ocrText = performOcrOnPdf(pdfFile.getId());
  const transactions = [];
  let totalAmount = 0;
  let totalRecords = 0;

  // --- FIX APPLIED HERE ---
  // 1. Removed strict lookahead (?=...) constraints.
  // 2. Pattern now creates 3 groups:
  //    Group 1: Account Number (10 digits with hyphens)
  //    Group 2: Account Name (Non-greedy match of anything in between)
  //    Group 3: Amount (Number with commas/decimals)
  //    Constraint: The amount must be followed by a whitespace or end of line, avoiding accidental partial matches.
  const transactionRegex = /(\d{4}-\d{4}-\d{2})\s+([\s\S]+?)\s+([\d,]+\.\d{2})(?!\d)/g;
  
  let match;

  while ((match = transactionRegex.exec(ocrText)) !== null) {
    // Extra validation: Ensure Group 2 (Name) doesn't contain "TOTAL" or "RECORDS" to prevent false positives
    // This protects against capturing the footer lines as a transaction.
    const rawName = match[2];
    if (rawName.includes("TOTAL NO.") || rawName.includes("TOTAL AMOUNT")) {
        continue;
    }

    const accountName = rawName.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
    
    transactions.push({
      accountNo: match[1].trim(),
      accountName: accountName,
      amount: parseFloat(match[3].replace(/,/g, ''))
    });
  }

  // New Strategy: Use regex that is flexible about where the numbers appear after the labels.
  const totalRecordsRegex = /TOTAL NO\. OF RECORDS\s*:\s*([\s\S]*?)(\d+)/;
  const totalAmountRegex = /TOTAL AMOUNT\s*:\s*([\s\S]*?)([\d,]+\.\d{2})/;

  const totalRecordsMatch = ocrText.match(totalRecordsRegex);
  const totalAmountMatch = ocrText.match(totalAmountRegex);

  // We want the LAST number found after the label.
  if (totalRecordsMatch) {
    totalRecords = parseInt(totalRecordsMatch[totalRecordsMatch.length-1], 10);
  }

  if (totalAmountMatch) {
    totalAmount = parseFloat(totalAmountMatch[totalAmountMatch.length-1].replace(/,/g, ''));
  }

  return { transactions, totalRecords, totalAmount, rawText: ocrText };
}

/**
 * A test function to check if the Payroll Register parser is working.
 * UPDATED to show the new data points (total records).
 */
function testPayrollParser() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt('Test Payroll Parser', 'Please enter the Google Drive File ID of a sample Payroll Register PDF:', ui.ButtonSet.OK_CANCEL);

  if (response.getSelectedButton() !== ui.Button.OK || response.getResponseText() === '') {
    return;
  }
  
  try {
    const fileId = response.getResponseText().trim();
    const file = DriveApp.getFileById(fileId);
    const parsedData = _parsePayrollRegisterPdf(file);
    
    if (parsedData.transactions.length === 0 || parsedData.totalAmount === 0) {
        // If it fails, show the raw text so we can see what the script is "seeing"
        ui.alert(`Parsing Failed`, `The script could not find transactions or a total amount. This is the text it extracted from the PDF:\n\n${parsedData.rawText}`, ui.ButtonSet.OK);
        return;
    }

    // Format the output for the alert box
    let outputMessage = `Parsing Successful!\n\n`;
    outputMessage += `Total Amount Found: ${parsedData.totalAmount.toFixed(2)}\n`;
    outputMessage += `Total Records Found: ${parsedData.totalRecords}\n`;
    outputMessage += `Transactions Found: ${parsedData.transactions.length}\n\n`;
    outputMessage += `--- First 3 Transactions ---\n`;
    
    parsedData.transactions.slice(0, 3).forEach(t => {
        outputMessage += `Name: ${t.accountName}, Acct: ${t.accountNo}, Amt: ${t.amount.toFixed(2)}\n`;
    });

    ui.alert(outputMessage);

  } catch (e) {
    ui.alert(`An error occurred: ${e.message}`);
  }
}

/**
 * Compares data from the Payroll Register PDF against the batch data in the spreadsheet.
 * UPDATED to correctly validate SDO-PCF transactions.
 */
function _validateBatchData(batchNo, payrollData) {
    // 1. Get batch data from all necessary sheets
    const masterSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Master_DV_List');
    const masterData = masterSheet.getDataRange().getValues();
    const headers = masterSheet.getRange('A1:P1').getValues()[0];

    const payeeDbSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Payee_Database');
    const payeeDbData = payeeDbSheet.getDataRange().getValues();
    const accountMap = new Map(payeeDbData.map(row => [row[0], row[1]]));

    // Load the SDO PCF Accounts
    const sdoSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('SDO_PCF_Accounts');
    const sdoData = sdoSheet.getDataRange().getValues();
    const sdoAccountMap = new Map(sdoData.map(row => [row[0], row[1]]));

    const sheetTransactions = [];
    let sheetTotalAmount = 0.0;
    
    const batchNoCol = headers.indexOf('Batch No');
    const payeeNameCol = headers.indexOf('Payee Name');
    const amountCol = headers.indexOf('Amount Due');
    const transTypeCol = headers.indexOf('Transaction Type');

    for (const row of masterData) {
        if (row[batchNoCol] === batchNo) {
            const payeeName = row[payeeNameCol];
            const transactionType = row[transTypeCol];
            let accountNoValue;

            // "Smart" SDO Account Selection Logic
            if (transactionType === 'Replenishment of Petty Cash Funds' || transactionType === 'Establishment of Revolving Fund') {
                accountNoValue = sdoAccountMap.get(payeeName);
            }
            if (!accountNoValue) {
                accountNoValue = accountMap.get(payeeName);
            }
            
            const accountNo = (accountNoValue || '').toString().padStart(10, '0');
            
            sheetTransactions.push({
                payeeName: payeeName,
                accountNo: accountNo,
                amount: parseFloat(row[amountCol])
            });
            sheetTotalAmount += parseFloat(row[amountCol]);
        }
    }

    // 2. Perform Validations
    const errors = [];
    
    const cleanName = (name) => name.toUpperCase().replace(/[.,\s]/g, '');

    if (Math.abs(sheetTotalAmount - payrollData.totalAmount) > 0.01) {
        errors.push(`- Total Amount Mismatch: Sheet Total = ${sheetTotalAmount.toFixed(2)}, PDF Total = ${payrollData.totalAmount.toFixed(2)}`);
    }

    if (sheetTransactions.length !== payrollData.transactions.length) {
        errors.push(`- Transaction Count Mismatch: Sheet Count = ${sheetTransactions.length}, PDF Count = ${payrollData.transactions.length}`);
    }

    // 3. Line-by-line check
    for (const pdfTrans of payrollData.transactions) {
        const pdfAccountNo = pdfTrans.accountNo.replace(/-/g, '');
        
        const sheetMatch = sheetTransactions.find(sheetTrans => sheetTrans.accountNo.replace(/-/g, '') === pdfAccountNo);

        if (!sheetMatch) {
            errors.push(`- Payee Not Found in Sheet Batch: "${pdfTrans.accountName}" from PDF with account ...${pdfAccountNo.slice(-4)}.`);
            continue;
        }

        if (Math.abs(sheetMatch.amount - pdfTrans.amount) > 0.01) {
            errors.push(`- Amount Mismatch for "${pdfTrans.accountName}": Sheet = ${sheetMatch.amount.toFixed(2)}, PDF = ${pdfTrans.amount.toFixed(2)}`);
        }
    }

    if (errors.length > 0) {
        return { isValid: false, error: "Validation Failed:\n\n" + errors.join('\n') };
    }

    return { isValid: true, message: "Validation Successful! All totals, counts, and transaction details match." };
}

/**
 * A test function to check the batch validation logic.
 * UPDATED to fix a typo in a variable name.
 */
function testBatchValidation() {
  const ui = SpreadsheetApp.getUi();
  const batchNoResponse = ui.prompt('Test Batch Validation', 'Please enter the Batch Number to validate:', ui.ButtonSet.OK_CANCEL);
  if (batchNoResponse.getSelectedButton() !== ui.Button.OK || batchNoResponse.getResponseText() === '') return;
  const batchNo = batchNoResponse.getResponseText().trim();

  const fileIdResponse = ui.prompt('Test Batch Validation', 'Please enter the File ID of the corresponding Payroll Register PDF:', ui.ButtonSet.OK_CANCEL);
  if (fileIdResponse.getSelectedButton() !== ui.Button.OK || fileIdResponse.getResponseText() === '') return;
  const fileId = fileIdResponse.getResponseText().trim();
  
  try {
    const file = DriveApp.getFileById(fileId);
    const parsedData = _parsePayrollRegisterPdf(file);
    
    if (parsedData.transactions.length === 0) {
      throw new Error("Could not parse any transactions from the PDF.");
    }

    // Run the validation
    const validationResult = _validateBatchData(batchNo, parsedData);

    // --- FIX: Corrected the variable name from "validation_result" to "validationResult" ---
    if (validationResult.isValid) {
      ui.alert('Validation Successful!', validationResult.message, ui.ButtonSet.OK);
    } else {
      ui.alert('Validation Failed', validationResult.error, ui.ButtonSet.OK);
    }

  } catch (e) {
    ui.alert(`An error occurred: ${e.message}`);
  }
}

/**
 * A test function to check the entire Credit Memo validation logic.
 */
function testCreditMemoValidation() {
  const ui = SpreadsheetApp.getUi();
  const batchNoResponse = ui.prompt('Test Credit Memo Validation', 'Please enter the Batch Number to validate:', ui.ButtonSet.OK_CANCEL);
  if (batchNoResponse.getSelectedButton() !== ui.Button.OK || batchNoResponse.getResponseText() === '') return;
  const batchNo = batchNoResponse.getResponseText().trim();

  const fileIdResponse = ui.prompt('Test Credit Memo Validation', 'Please enter the File ID of the corresponding Credit Memo spreadsheet (XLSX):', ui.ButtonSet.OK_CANCEL);
  if (fileIdResponse.getSelectedButton() !== ui.Button.OK || fileIdResponse.getResponseText() === '') return;
  const fileId = fileIdResponse.getResponseText().trim();
  
  try {
    const file = DriveApp.getFileById(fileId);
    const parsedData = _parseCreditMemoSheet(file);
    
    if (parsedData.transactions.length === 0) {
      throw new Error("Could not parse any transactions from the Credit Memo file. Please check the file's contents and format.");
    }

    const validationResult = _validateCreditMemoData(batchNo, parsedData);

    if (validationResult.isValid) {
      ui.alert('Validation Successful!', validationResult.message, ui.ButtonSet.OK);
    } else {
      ui.alert('Validation Failed', validationResult.error, ui.ButtonSet.OK);
    }

  } catch (e) {
    ui.alert(`An error occurred: ${e.message}`);
  }
}


/**
 * Reads a WeAccess Credit Memo (.xlsx) file by converting it to a temporary Google Sheet.
 * FINAL version: Uses a more reliable method to find the start of the data.
 * @param {GoogleAppsScript.Drive.File} file The spreadsheet file to process.
 * @return {object} An object containing a list of transactions, total count, and total amount.
 */
function _parseCreditMemoSheet(file) {
  let tempCreatedFileId = null;
  try {
    const resource = {
      title: `temp_credit_memo_${new Date().getTime()}`,
      parents: [{ id: DriveApp.getRootFolder().getId() }]
    };
    const tempFile = Drive.Files.insert(resource, file.getBlob(), { convert: true });
    tempCreatedFileId = tempFile.id;
    const ss = SpreadsheetApp.openById(tempCreatedFileId);
    const sheet = ss.getSheets()[0];
    const rows = sheet.getDataRange().getValues();
    
    const transactions = [];
    let totalCount = 0;
    let totalAmount = 0;

    let dataStartRow = -1;
    // --- FINAL FIX: Find the first row that looks like a transaction ---
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      // A valid data row must have an account number in the first column AND an amount in the fourth column.
      if (row[0] && /^\d{4}-\d{4}-\d{2}$/.test(row[0].toString().trim()) && !isNaN(parseFloat(row[3]))) {
        dataStartRow = i;
        break;
      }
    }

    if (dataStartRow === -1) {
      throw new Error("Could not find the starting row of transaction data in the Credit Memo file.");
    }

    // Since the format is fixed, we use fixed column indexes after finding the start
    for (let i = dataStartRow; i < rows.length; i++) {
      const row = rows[i];
      // Stop if the row format no longer matches
      if (!row[0] || !/^\d{4}-\d{4}-\d{2}$/.test(row[0].toString().trim())) break;

      transactions.push({
        destinationAccount: row[0], // Account is in Column A
        amount: parseFloat(row[3]), // Amount is in Column D
        timestamp: row[4],        // Timestamp is in Column E
        remarks: row[5]           // Remarks is in Column F
      });
    }

    for (let i = dataStartRow + transactions.length; i < rows.length; i++) {
      const row = rows[i];
      if (row[0] && row[0].toString().toLowerCase().includes('total count')) {
        totalCount = parseInt(row[1], 10);
      }
      if (row[0] && row[0].toString().toLowerCase().includes('total amount debited')) {
        totalAmount = parseFloat(row[1]);
      }
    }
    
    return { transactions, totalCount, totalAmount };

  } finally {
    if (tempCreatedFileId) {
      DriveApp.getFileById(tempCreatedFileId).setTrashed(true);
    }
  }
}



/**
 * Compares data from the Credit Memo against the batch data in the spreadsheet.
 * This version uses "bulletproof" account number cleaning.
 * @param {string} batchNo The batch number to validate.
 * @param {object} creditMemoData The data parsed from the Credit Memo.
 * @return {object} An object indicating if the data is valid and providing an error message if not.
 */
function _validateCreditMemoData(batchNo, creditMemoData) {
  const masterSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Master_DV_List');
  const masterData = masterSheet.getDataRange().getValues();
  const headers = masterSheet.getRange('A1:R1').getValues()[0];
  
  const payeeDbSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Payee_Database');
  const payeeDbData = payeeDbSheet.getDataRange().getValues();
  const accountMap = new Map(payeeDbData.map(row => [row[0], row[1]]));

  const sheetTransactions = [];
  let sheetTotalAmount = 0.0;
  
  const batchNoCol = headers.indexOf('Batch No');
  const payeeNameCol = headers.indexOf('Payee Name');
  const amountCol = headers.indexOf('Amount Due');

  for (const row of masterData) {
    if (row[batchNoCol] === batchNo) {
      const payeeName = row[payeeNameCol];
      const rawAccountNo = (accountMap.get(payeeName) || '').toString();
      let cleanAccountNo = rawAccountNo.replace(/\D/g, '');
      
      if (cleanAccountNo.length === 9) {
        cleanAccountNo = '0' + cleanAccountNo;
      }
      
      sheetTransactions.push({
        payeeName: payeeName,
        accountNo: cleanAccountNo,
        amount: parseFloat(row[amountCol])
      });
      sheetTotalAmount += parseFloat(row[amountCol]);
    }
  }

  const errors = [];
  
  if (Math.abs(sheetTotalAmount - creditMemoData.totalAmount) > 0.01) {
    errors.push(`- Total Amount Mismatch: Sheet Total = ${sheetTotalAmount.toFixed(2)}, Credit Memo Total = ${creditMemoData.totalAmount.toFixed(2)}`);
  }

  if (sheetTransactions.length !== creditMemoData.totalCount) {
    errors.push(`- Transaction Count Mismatch: Sheet Count = ${sheetTransactions.length}, Credit Memo Count = ${creditMemoData.totalCount}`);
  }

  for (const sheetTrans of sheetTransactions) {
    const memoMatch = creditMemoData.transactions.find(memoTrans => {
        if (!memoTrans || !memoTrans.destinationAccount) return false;
        const cleanMemoAcct = memoTrans.destinationAccount.toString().replace(/\D/g, '');
        return cleanMemoAcct === sheetTrans.accountNo;
    });

    if (!memoMatch) {
      errors.push(`- Account Not Found in Credit Memo: Account for "${sheetTrans.payeeName}" (...${sheetTrans.accountNo.slice(-4)}) was not in the report.`);
      continue;
    }
    
    if (Math.abs(sheetTrans.amount - memoMatch.amount) > 0.01) {
      errors.push(`- Amount Mismatch for "${sheetTrans.payeeName}": Sheet = ${sheetTrans.amount.toFixed(2)}, Credit Memo = ${memoMatch.amount.toFixed(2)}`);
    }

    if (memoMatch.remarks.toLowerCase() !== 'completed') {
        errors.push(`- Payment Failed for "${sheetTrans.payeeName}": Remarks state "${memoMatch.remarks}"`);
    }
  }

  if (errors.length > 0) {
    return { isValid: false, error: "Validation Failed:\n\n" + errors.join('\n') };
  }

  return { isValid: true, message: "Validation Successful! All totals, counts, and transaction details match." };
}

/**
 * Finds and returns the PDF link for a single DV number.
 * This is called on-demand by the web app's PDF viewer.
 * @param {string} dvNumber The DV number to search for.
 * @return {string} The Google Drive URL of the PDF, or null if not found.
 */
function getPdfLinkForDv(dvNumber) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Master_DV_List');
  const data = sheet.getDataRange().getValues();
  const headers = data.shift();
  const dvNoCol = headers.indexOf('DV No');
  const pdfLinkCol = headers.indexOf('PDF_Link');

  for (const row of data) {
    if (row[dvNoCol] && row[dvNoCol].toString() === dvNumber) {
      return row[pdfLinkCol];
    }
  }
  return null; // Return null if not found
}

// --- WEB APP ACTION FUNCTIONS (STANDALONE) ---

function createBatchFromWebApp(dvNumbers) {
  return _withScriptLock(() => _createBatchFromWebApp(dvNumbers));
}

function _createBatchFromWebApp(dvNumbers) {
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Master_DV_List');
    const dataRange = sheet.getRange('A2:P' + sheet.getLastRow()); 
    const data = dataRange.getValues();
    
    const headers = sheet.getRange('A1:P1').getValues()[0];
    const dvNoCol = headers.indexOf('DV No');
    const statusCol = headers.indexOf('Status');
    const batchNoCol = headers.indexOf('Batch No');

    const now = new Date();
    const year = now.getFullYear();
    const month = ('0' + (now.getMonth() + 1)).slice(-2);

    const batchNumbersInSheet = sheet.getRange(2, batchNoCol + 1, sheet.getLastRow() - 1, 1).getValues().flat().filter(bn => bn && bn.startsWith(`${year}-${month}`));
    const lastSerial = batchNumbersInSheet.length > 0 ? Math.max(...batchNumbersInSheet.map(bn => parseInt(bn.split('-')[2]))) : 0;
    const newSerialNumber = ('000' + (lastSerial + 1)).slice(-4);
    const newBatchNumber = `${year}-${month}-${newSerialNumber}`;

    // Only DVs still waiting for batching: a repeat request (double click, second tab)
    // must not move already-batched DVs into another batch.
    let batchedCount = 0;
    for (let i = 0; i < data.length; i++) {
        if (dvNumbers.includes(data[i][dvNoCol].toString()) && data[i][statusCol] === 'For Processing') {
            sheet.getRange(i + 2, statusCol + 1).setValue('Batched for Approval');
            sheet.getRange(i + 2, batchNoCol + 1).setValue(newBatchNumber);
            batchedCount++;
        }
    }
    if (batchedCount === 0) {
        return { success: false, message: 'The selected DVs have already been batched. Please refresh the page.' };
    }
    return { success: true, message: `Batch ${newBatchNumber} created successfully.` };
  } catch (e) {
    return { success: false, message: `Error: ${e.message}` };
  }
}

/**
 * Generates the FINDES file for a given batch from the web app.
 * UPDATED to include the batch number in the SDO confirmation message.
 */
function _generateFindesForWebApp(batchNo) {
    try {
        const masterSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Master_DV_List');
        const payeeDbSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Payee_Database');
        const payeeDbData = payeeDbSheet.getDataRange().getValues();
        const payeeMap = new Map(payeeDbData.map(row => [row[0], row[1]]));

        const sdoSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('SDO_PCF_Accounts');
        const sdoData = sdoSheet.getDataRange().getValues();
        const sdoAccountMap = new Map(sdoData.map(row => [row[0], row[1]]));

        let findesContent = '';
        const headers = masterSheet.getRange('A1:P1').getValues()[0];
        const payeeNameCol = headers.indexOf('Payee Name');
        const amountCol = headers.indexOf('Amount Due');
        const batchNoCol = headers.indexOf('Batch No');
        const statusCol = headers.indexOf('Status');
        const transTypeCol = headers.indexOf('Transaction Type');

        const allSheetData = masterSheet.getRange("A2:P" + masterSheet.getLastRow()).getValues();

        let transactionCount = 0;
        const sdosMissingAccount = [];

        for (const row of allSheetData) {
            if (row[batchNoCol] === batchNo) {
                const payeeName = row[payeeNameCol];
                const transactionType = row[transTypeCol];
                let accountNo;

                if (transactionType === 'Replenishment of Petty Cash Funds' || transactionType === 'Establishment of Revolving Fund') {
                    if (sdoAccountMap.has(payeeName)) {
                        accountNo = sdoAccountMap.get(payeeName);
                    } else {
                        if (!sdosMissingAccount.includes(payeeName)) {
                            sdosMissingAccount.push(payeeName);
                        }
                        accountNo = payeeMap.get(payeeName);
                    }
                } else {
                    accountNo = payeeMap.get(payeeName);
                }

                if (!accountNo) {
                    throw new Error(`A valid bank account could not be found for "${payeeName}". Please ensure they are enrolled correctly.`);
                }
                
                let cleanedName = payeeName;
                const firstCommaIndex = payeeName.indexOf(',');
                if (firstCommaIndex > -1) {
                    const surnamePart = payeeName.substring(0, firstCommaIndex + 1);
                    const restOfName = payeeName.substring(firstCommaIndex + 1);
                    cleanedName = surnamePart + restOfName.replace(/[.,'-]/g, '');
                } else {
                    cleanedName = payeeName.replace(/[.,'-]/g, '');
                }
                cleanedName = cleanedName.toUpperCase().replace(/Ñ/g, 'N').replace(/\s+/g, ' ').trim();
                
                const amount = row[amountCol];
                const formattedAmount = (amount * 100).toFixed(0);
                findesContent += `${accountNo},"${cleanedName}",${formattedAmount}\n`;
                transactionCount++;
            }
        }

        if (transactionCount === 0) {
            throw new Error(`No transactions found for batch number "${batchNo}".`);
        }

        if (sdosMissingAccount.length > 0) {
            // --- FIX: Added the batch number to the confirmation message ---
            const message = `For batch number "${batchNo}", the following payee(s) have a PCF transaction but no enrolled SDO account: ${sdosMissingAccount.join(', ')}. Do you wish to proceed using their regular payroll account instead?`;
            return { success: false, requiresConfirmation: true, confirmationMessage: message };
        }

        saveFindesFile(findesContent, batchNo);

        for (let i = 0; i < allSheetData.length; i++) {
            if (allSheetData[i][batchNoCol] === batchNo) {
                masterSheet.getRange(i + 2, statusCol + 1).setValue('FINDES Generated');
            }
        }
        return { success: true, message: `FINDES file for ${batchNo} generated and status updated.` };
    } catch (e) {
        return { success: false, message: `Error: ${e.message}` };
    }
}


/**
 * A new function to proceed with FINDES generation after user confirmation.
 * This version will always use the regular payroll account for all payees in the batch.
 */
function _generateFindesForWebAppWithOverride(batchNo) {
    try {
        const masterSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Master_DV_List');
        const payeeDbSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Payee_Database');
        const payeeDbData = payeeDbSheet.getDataRange().getValues();
        const payeeMap = new Map(payeeDbData.map(row => [row[0], row[1]]));

        let findesContent = '';
        const headers = masterSheet.getRange('A1:P1').getValues()[0];
        const payeeNameCol = headers.indexOf('Payee Name');
        const amountCol = headers.indexOf('Amount Due');
        const batchNoCol = headers.indexOf('Batch No');
        const statusCol = headers.indexOf('Status');
        
        const allSheetData = masterSheet.getRange("A2:P" + masterSheet.getLastRow()).getValues();

        let transactionCount = 0;
        for (const row of allSheetData) {
            if (row[batchNoCol] === batchNo) {
                const payeeName = row[payeeNameCol];
                // OVERRIDE: Always use the regular payroll account from Payee_Database
                const accountNo = payeeMap.get(payeeName);

                if (!accountNo) {
                    throw new Error(`Landbank account not found for "${payeeName}".`);
                }
                
                let cleanedName = payeeName;
                const firstCommaIndex = payeeName.indexOf(',');
                if (firstCommaIndex > -1) {
                    const surnamePart = payeeName.substring(0, firstCommaIndex + 1);
                    const restOfName = payeeName.substring(firstCommaIndex + 1);
                    cleanedName = surnamePart + restOfName.replace(/[.,'-]/g, '');
                } else {
                    cleanedName = payeeName.replace(/[.,'-]/g, '');
                }
                cleanedName = cleanedName.toUpperCase().replace(/Ñ/g, 'N').replace(/\s+/g, ' ').trim();
                
                const amount = row[amountCol];
                const formattedAmount = (amount * 100).toFixed(0);
                findesContent += `${accountNo},"${cleanedName}",${formattedAmount}\n`;
                transactionCount++;
            }
        }

        if (transactionCount === 0) {
            throw new Error(`No transactions found for batch number "${batchNo}".`);
        }

        saveFindesFile(findesContent, batchNo);

        for (let i = 0; i < allSheetData.length; i++) {
            if (allSheetData[i][batchNoCol] === batchNo) {
                masterSheet.getRange(i + 2, statusCol + 1).setValue('FINDES Generated');
            }
        }
        return { success: true, message: `FINDES file for ${batchNo} generated using the regular payroll account as confirmed.` };
    } catch (e) {
        return { success: false, message: `Error: ${e.message}` };
    }
}





/**
 * Web app function for requesting endorsement.
 * This version includes automatic validation of the Payroll Register PDF.
 */
function _requestEndorsementForWebApp(batchNo, refNo, fileData) {
  try {
    // --- VALIDATION STEP ---
    // Create a temporary file from the uploaded data to get a File ID for the OCR function.
    const tempPayrollBlob = Utilities.newBlob(Utilities.base64Decode(fileData.bytes), fileData.mimeType, fileData.name);
    const tempFile = DriveApp.getRootFolder().createFile(tempPayrollBlob); 
    const payrollData = _parsePayrollRegisterPdf(tempFile);
    
    // Clean up the temporary file immediately after parsing.
    DriveApp.getFileById(tempFile.getId()).setTrashed(true); 

    // Run the validation against the parsed data from the PDF.
    const validationResult = _validateBatchData(batchNo, payrollData);
    
    if (!validationResult.isValid) {
      // If validation fails, stop the process and return the detailed error message to the web app.
      return { success: false, message: validationResult.error };
    }
    // --- END OF VALIDATION ---

    // If validation passes, rename the file and proceed by calling the main endorsement function.
    const newFileName = `Payroll Register - ${batchNo} - ${refNo}.pdf`;
    fileData.name = newFileName; // Update the file name for archival.

    const dataObject = { batchNo: batchNo, weaccessRef: refNo, payrollFile: fileData };
    
    // Call your original, unchanged requestEndorsement function to do the work.
    requestEndorsement(dataObject);
    
    return { success: true, message: `Validation Successful! Endorsement request for ${batchNo} sent.` };

  } catch (e) {
    return { success: false, message: `Error during validation: ${e.message}` };
  }
}

// --- DUPLICATE-ACTION GUARDS ---
// Each Treasury step runs under the script lock and only when the batch is at the step it
// belongs to, so a repeated request (double click, second tab, two users) changes nothing.

function _withScriptLock(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    return { success: false, message: 'Another action is still running. Please try again in a minute.' };
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/** Error message if any DV in the batch is not at expectedStatus, else null. */
function _batchNotAtStatus(batchNo, expectedStatus) {
  const data = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Master_DV_List').getDataRange().getValues();
  const headers = data[0];
  const batchNoCol = headers.indexOf('Batch No');
  const statusCol = headers.indexOf('Status');
  const statuses = data.slice(1)
    .filter(row => row[batchNoCol] && row[batchNoCol].toString() === batchNo.toString())
    .map(row => row[statusCol]);
  if (statuses.length === 0) return `No transactions found for batch "${batchNo}".`;
  const other = statuses.find(st => st !== expectedStatus);
  return other ? `Batch "${batchNo}" has already moved past this step (status: ${other}). Please refresh the page.` : null;
}

function generateFindesForWebApp(batchNo) {
  return _withScriptLock(() => {
    const blocked = _batchNotAtStatus(batchNo, 'Batched for Approval');
    return blocked ? { success: false, message: blocked } : _generateFindesForWebApp(batchNo);
  });
}

function generateFindesForWebAppWithOverride(batchNo) {
  return _withScriptLock(() => {
    const blocked = _batchNotAtStatus(batchNo, 'Batched for Approval');
    return blocked ? { success: false, message: blocked } : _generateFindesForWebAppWithOverride(batchNo);
  });
}

function requestEndorsementForWebApp(batchNo, refNo, fileData) {
  return _withScriptLock(() => {
    const blocked = _batchNotAtStatus(batchNo, 'FINDES Generated');
    return blocked ? { success: false, message: blocked } : _requestEndorsementForWebApp(batchNo, refNo, fileData);
  });
}

function notifyAccountingForWebApp(batchNo) {
  return _withScriptLock(() => _notifyAccountingForWebApp(batchNo));
}

function _notifyAccountingForWebApp(batchNo) {
    try {
        // notifyAccounting() returns { success: false } when the batch isn't ready; pass that through.
        return notifyAccounting(batchNo);
    } catch (e) {
        return { success: false, message: `Error: ${e.message}` };
    }
}

/**
 * Web app function for finalizing a batch (Stage 5).
 * payload: { debitMemo, successReport, unsuccessReport, noSuccessful } — files as { name, mimeType, bytes }.
 *
 * Every DV in the batch must be accounted for by the LandBank Report on Successful Transactions,
 * or by the Report on Unsuccessful Transactions. When DVs are missing from the successful report
 * and no unsuccessful report was sent, it returns { needsUnsuccessfulReport: true, missing } so the
 * hub can ask for it. Nothing is changed or emailed until both reports reconcile with the batch.
 */
function finalizeBatchForWebApp(batchNo, payload) {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(30000)) {
        return { success: false, message: 'Another batch is being finalized. Please try again in a minute.' };
    }
    const savedReports = [];
    try {
        if (!payload || !payload.debitMemo) throw new Error('Please upload the Debit Memo.');
        const noSuccessful = !!payload.noSuccessful;
        if (!noSuccessful && !payload.successReport) throw new Error('Please upload the Report on Successful Transactions.');
        if (noSuccessful && !payload.unsuccessReport) throw new Error('Please upload the Report on Unsuccessful Transactions.');

        const batchRows = _getBatchRowsWithAccounts(batchNo);
        if (batchRows.length === 0) throw new Error(`No transactions found for batch "${batchNo}".`);
        const notReady = batchRows.find(r => r.status !== 'Pending WeAccess Approval');
        if (notReady) throw new Error(`Batch "${batchNo}" is not awaiting finalization (status: ${notReady.status}).`);
        const weaccessRef = (batchRows.find(r => r.weaccessRef) || {}).weaccessRef;
        if (!weaccessRef) throw new Error('Could not find the WeAccess Reference Number for this batch.');
        const noAccount = batchRows.filter(r => !r.accountNo);
        if (noAccount.length) throw new Error('No LandBank account on file for: ' + noAccount.map(r => r.payeeName).join(', '));

        const batchFolder = getBatchFolder(batchNo);
        const errors = [];
        const pool = batchRows.slice(); // batch DVs not yet found in a report
        let successes = [];
        let failures = [];

        // Saves the upload, reads it, and checks it is the expected report for this batch's TRN.
        const readReport = (fileData, expectedType, label) => {
            const file = _saveUploadedFile(fileData, batchFolder, `TEMP ${label} - ${batchNo}`);
            savedReports.push(file);
            const report = _parseTransferReport(file.getId());
            if (report.type !== expectedType) {
                errors.push(`- The file uploaded as the ${label} is a Report on ${report.type} Transactions.`);
                return null;
            }
            if (report.trn.replace(/\D/g, '') !== weaccessRef.toString().replace(/\D/g, '')) {
                errors.push(`- ${label}: TRN ${report.trn || '(not found)'} does not match this batch's TRN ${weaccessRef}.`);
                return null;
            }
            return { file: file, report: report };
        };

        let successReport = null;
        if (!noSuccessful) {
            successReport = readReport(payload.successReport, 'SUCCESSFUL', 'Report on Successful Transactions');
            if (successReport) successes = _matchReportRows(pool, successReport.report.transactions, 'Successful report', errors);
        }
        if (errors.length) return _rejectFinalize(savedReports, errors);

        if (pool.length > 0 && !payload.unsuccessReport) {
            _trashFiles(savedReports);
            return {
                success: false,
                needsUnsuccessfulReport: true,
                message: `${pool.length} transaction(s) in batch ${batchNo} are not in the Report on Successful Transactions. Please also upload the Report on Unsuccessful Transactions.`,
                missing: pool.map(r => `${r.payeeName} (DV ${r.dvNo}) - ${r.amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
            };
        }

        let unsuccessReport = null;
        if (payload.unsuccessReport) {
            unsuccessReport = readReport(payload.unsuccessReport, 'UNSUCCESSFUL', 'Report on Unsuccessful Transactions');
            if (unsuccessReport) failures = _matchReportRows(pool, unsuccessReport.report.transactions, 'Unsuccessful report', errors);
        }
        if (pool.length > 0) {
            errors.push('- Not found in either report: ' + pool.map(r => `${r.payeeName} (DV ${r.dvNo})`).join(', '));
        }
        if (errors.length) return _rejectFinalize(savedReports, errors);

        // Validated: file the reports and the debit memo under their standard names.
        if (successReport) successReport.file.setName(`Report on Successful Transactions - ${batchNo} - ${weaccessRef}.xlsx`);
        if (unsuccessReport) unsuccessReport.file.setName(`Report on Unsuccessful Transactions - ${batchNo} - ${weaccessRef}.xlsx`);
        const memoExt = (payload.debitMemo.name.match(/\.[A-Za-z0-9]+$/) || ['.pdf'])[0];
        _saveUploadedFile(payload.debitMemo, batchFolder, `Debit Memo - ${batchNo} - ${weaccessRef}${memoExt}`);
        savedReports.length = 0; // filed for good: keep them even if a later step fails

        const message = finalizeBatch({ batchNo, weaccessRef, batchFolder, successes, failures });
        return { success: true, message: message };
    } catch (e) {
        _trashFiles(savedReports);
        return { success: false, message: e.message };
    } finally {
        lock.releaseLock();
    }
}


/**
 * Main orchestrator for Stage 5, run after the transfer reports have been validated.
 * Successful DVs: Annex H, 'Approved & Emailed', fund transfer confirmation email.
 * Unsuccessful DVs: listed in red on Annex H, then returned to For Batching (no payee email).
 */
function finalizeBatch({ batchNo, weaccessRef, batchFolder, successes, failures }) {
  const failureLog = failures.map(f => ({ dvNo: f.dvNo, payeeName: f.payeeName, amount: f.amount, reason: f.remarks }));

  if (successes.length > 0) {
    // Annex H first, while the unsuccessful DVs still belong to the batch.
    generateAnnexH(batchNo, weaccessRef, batchFolder, new Map(failures.map(f => [f.dvNo, f.remarks])));
  }

  _returnFailedDvsToBatching(batchNo, weaccessRef, failures);

  if (successes.length === 0) {
    _sendNoPaymentNoticeToAccounting(batchNo, weaccessRef, batchFolder, failureLog);
    return `Batch "${batchNo}" had no successful transfers. All ${failures.length} DV(s) are back in For Batching, and Accounting has been sent the reports.`;
  }

  updateStatusAndArchiveDvs(batchNo); // only the successful DVs are still in the batch
  sendPayeeEmails(batchNo);

  if (failureLog.length > 0) {
    // Read by notifyAccounting() (Stage 6) for the unsuccessful-transfers section.
    PropertiesService.getScriptProperties().setProperty(`UNSUCCESSFUL_${batchNo}`, JSON.stringify(failureLog));
    return `Batch "${batchNo}" has been finalized. ${successes.length} confirmation email(s) sent. ` +
      `${failures.length} unsuccessful transfer(s) were returned to For Batching: ` +
      failureLog.map(f => `${f.payeeName} (DV ${f.dvNo})`).join(', ') + '.';
  }
  return `Batch "${batchNo}" has been finalized. Annex H has been generated and ${successes.length} confirmation email(s) sent.`;
}

// --- STAGE 5: TRANSFER REPORT HELPERS ---

const ACCOUNTING_RECIPIENTS = 'padillaj@dap.edu.ph,baguim@dap.edu.ph,preciadosr@dap.edu.ph';
const MASTER_EXTRA_COLUMNS = ['Transfer Remarks', 'Cancel Reason', 'Cancelled By', 'Cancelled On'];

/**
 * Adds any missing MASTER_EXTRA_COLUMNS headers to Master_DV_List and returns the full header row.
 */
function _ensureMasterColumns(sheet) {
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const missing = MASTER_EXTRA_COLUMNS.filter(h => headers.indexOf(h) === -1);
  if (missing.length) {
    sheet.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]);
    headers.push(...missing);
  }
  return headers;
}

function _normalizeAccountNo(value) {
  const digits = (value || '').toString().replace(/\D/g, '');
  return digits ? digits.padStart(10, '0') : '';
}

/**
 * Batch DVs with the LandBank account FINDES used for each (SDO account for PCF/RF, else payroll).
 */
function _getBatchRowsWithAccounts(batchNo) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const data = ss.getSheetByName('Master_DV_List').getDataRange().getValues();
  const headers = data[0];
  const col = name => headers.indexOf(name);
  const accountMap = new Map(ss.getSheetByName('Payee_Database').getDataRange().getValues().map(r => [r[0], r[1]]));
  const sdoMap = new Map(ss.getSheetByName('SDO_PCF_Accounts').getDataRange().getValues().map(r => [r[0], r[1]]));

  const rows = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[col('Batch No')] || row[col('Batch No')].toString() !== batchNo.toString()) continue;
    const payeeName = row[col('Payee Name')];
    const transactionType = row[col('Transaction Type')];
    let account;
    if (transactionType === 'Replenishment of Petty Cash Funds' || transactionType === 'Establishment of Revolving Fund') {
      account = sdoMap.get(payeeName);
    }
    if (!account) account = accountMap.get(payeeName);
    rows.push({
      rowNumber: i + 1,
      dvNo: row[col('DV No')].toString(),
      payeeName: payeeName,
      amount: parseFloat(row[col('Amount Due')]) || 0,
      status: row[col('Status')],
      weaccessRef: row[col('WeAccess Ref No')],
      accountNo: _normalizeAccountNo(account)
    });
  }
  return rows;
}

/**
 * Reads a LandBank WeAccess "Report on Successful/Unsuccessful Transactions" (.xlsx) by
 * converting a temporary copy to a Google Sheet.
 * @return {{type: string, trn: string, transactions: Array<{accountNo, amount, remarks}>}}
 */
function _parseTransferReport(fileId) {
  const copy = Drive.Files.copy(
    { name: `temp_transfer_report_${new Date().getTime()}`, mimeType: MimeType.GOOGLE_SHEETS },
    fileId, { fields: 'id' });
  try {
    const rows = SpreadsheetApp.openById(copy.id).getSheets()[0].getDataRange().getDisplayValues();
    let type = '';
    let trn = '';
    let header = null;
    let footerCount = null;
    const transactions = [];

    for (const row of rows) {
      const line = row.join(' ').replace(/\s+/g, ' ').trim();
      if (!line) continue;

      if (!header) {
        // UNSUCCESSFUL must be tried first: it contains the word SUCCESSFUL.
        const typeMatch = line.match(/REPORT ON (UNSUCCESSFUL|SUCCESSFUL) TRANSACTIONS/i);
        if (typeMatch && !type) { type = typeMatch[1].toUpperCase(); continue; }
        const trnMatch = line.match(/Transaction Reference Number\s*:\s*([\d-]+)/i);
        if (trnMatch && !trn) { trn = trnMatch[1]; continue; }
        const upper = row.map(c => c.toString().toUpperCase().trim());
        const destCol = upper.indexOf('DESTINATION ACCOUNT');
        if (destCol > -1) {
          header = { dest: destCol, amount: upper.findIndex(c => c.startsWith('AMOUNT')), remarks: upper.indexOf('REMARKS') };
        }
        continue;
      }

      const firstCell = row[0].toString().trim();
      if (/^TOTAL/i.test(firstCell)) {
        // TOTAL COUNT / TOTAL AMOUNT DEBITED: never transaction rows, even if the amount has 9-10 digits.
        if (/^TOTAL COUNT/i.test(firstCell)) footerCount = parseInt(row[1].toString().replace(/\D/g, ''), 10);
        continue;
      }
      const accountDigits = row[header.dest].toString().replace(/\D/g, '');
      if (!/^\d{9,10}$/.test(accountDigits)) continue; // footer / blank lines
      transactions.push({
        accountNo: accountDigits.padStart(10, '0'),
        amount: parseFloat(row[header.amount].toString().replace(/,/g, '')) || 0,
        remarks: header.remarks > -1 ? row[header.remarks].toString().replace(/\s+/g, ' ').trim() : ''
      });
    }

    if (!type || !header) {
      throw new Error('The uploaded file is not a LandBank Report on Successful/Unsuccessful Transactions.');
    }
    if (footerCount !== null && !isNaN(footerCount) && footerCount !== transactions.length) {
      throw new Error(`The ${type.toLowerCase()} report's TOTAL COUNT is ${footerCount}, but ${transactions.length} transaction row(s) were read.`);
    }
    return { type: type, trn: trn, transactions: transactions };
  } finally {
    Drive.Files.remove(copy.id);
  }
}

/**
 * Pairs each report line with a batch DV by account AND amount, removing matched DVs from
 * the pool so a payee with two DVs in the batch is matched once per report line.
 */
function _matchReportRows(pool, transactions, reportLabel, errors) {
  const matched = [];
  for (const t of transactions) {
    const idx = pool.findIndex(r => r.accountNo === t.accountNo && Math.abs(r.amount - t.amount) < 0.01);
    if (idx === -1) {
      const sameAccount = pool.find(r => r.accountNo === t.accountNo);
      errors.push(sameAccount
        ? `- ${reportLabel}: amount ${t.amount.toFixed(2)} for account ...${t.accountNo.slice(-4)} does not match ${sameAccount.payeeName} (${sameAccount.amount.toFixed(2)}).`
        : `- ${reportLabel}: account ...${t.accountNo.slice(-4)} (${t.amount.toFixed(2)}) is not in this batch.`);
      continue;
    }
    matched.push(Object.assign({}, pool[idx], { remarks: t.remarks }));
    pool.splice(idx, 1);
  }
  return matched;
}

function _saveUploadedFile(fileData, folder, name) {
  const blob = Utilities.newBlob(Utilities.base64Decode(fileData.bytes), fileData.mimeType, name);
  return folder.createFile(blob);
}

function _trashFiles(files) {
  files.forEach(f => { try { f.setTrashed(true); } catch (e) { console.error('Could not trash temp report: ' + e.message); } });
}

function _rejectFinalize(savedReports, errors) {
  _trashFiles(savedReports);
  return { success: false, message: 'Validation Failed:\n\n' + errors.join('\n') };
}

/**
 * Sends unsuccessful DVs back to For Batching and records the bank's reason in Transfer Remarks.
 */
function _returnFailedDvsToBatching(batchNo, weaccessRef, failures) {
  if (!failures.length) return;
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Master_DV_List');
  const headers = _ensureMasterColumns(sheet);
  const col = name => headers.indexOf(name) + 1;
  const dateStr = Utilities.formatDate(new Date(), 'Asia/Manila', 'MM/dd/yyyy');

  for (const f of failures) {
    const remarkCell = sheet.getRange(f.rowNumber, col('Transfer Remarks'));
    const previous = remarkCell.getValue();
    const remark = `Unsuccessful - Batch ${batchNo} (TRN ${weaccessRef}) ${dateStr}: ${f.remarks}`;
    remarkCell.setValue(previous ? `${previous} | ${remark}` : remark);
    sheet.getRange(f.rowNumber, 1).setValue(false); // selection checkbox
    sheet.getRange(f.rowNumber, col('Status')).setValue('For Processing');
    sheet.getRange(f.rowNumber, col('Batch No')).setValue('');
    sheet.getRange(f.rowNumber, col('WeAccess Ref No')).setValue('');
  }
}

/**
 * Files in the batch folder to send to Accounting, skipping FINDES, native Google files, and
 * DV PDFs that no longer belong to this batch (e.g. unsuccessful DVs returned to For Batching).
 */
function _collectBatchAttachments(batchFolder, batchNo, masterData, headers) {
  const batchNoCol = headers.indexOf('Batch No');
  const pdfLinkCol = headers.indexOf('PDF_Link');
  const otherDvFileIds = new Set();
  for (const row of masterData) {
    if (row[batchNoCol] && row[batchNoCol].toString() === batchNo.toString()) continue;
    const link = row[pdfLinkCol];
    const match = typeof link === 'string' && (link.match(/\/d\/(.+?)\//) || link.match(/id=([^&]+)/));
    if (match) otherDvFileIds.add(match[1]);
  }

  // Annex H, debit memo, reports and register first, then the DVs.
  const rank = name => ['Annex H', 'Debit Memo', 'Report on Successful', 'Report on Unsuccessful', 'Payroll Register']
    .findIndex(prefix => name.indexOf(prefix) === 0);
  const files = [];
  const it = batchFolder.getFiles();
  while (it.hasNext()) {
    const file = it.next();
    if (file.getMimeType().indexOf('application/vnd.google-apps') === 0) continue;
    if (file.getName().indexOf('FINDES-') === 0) continue;
    if (otherDvFileIds.has(file.getId())) continue;
    files.push(file);
  }
  files.sort((a, b) => {
    const ra = rank(a.getName()), rb = rank(b.getName());
    return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb) || a.getName().localeCompare(b.getName());
  });
  return files.map(f => f.getBlob());
}

/**
 * Accounting email for a batch where every transfer failed: no Annex H and no JEV, but
 * Accounting still receives the debit memo, the unsuccessful report and the register.
 */
function _sendNoPaymentNoticeToAccounting(batchNo, weaccessRef, batchFolder, failureLog) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Master_DV_List');
  const masterData = sheet.getDataRange().getValues();
  const headers = masterData.shift();
  const attachments = _collectBatchAttachments(batchFolder, batchNo, masterData, headers);

  MailApp.sendEmail({
    to: ACCOUNTING_RECIPIENTS,
    subject: `For Information: E-Payment Batch ${batchNo} - No Successful Transfers`,
    htmlBody: _buildAccountingEmailHtml({
      batchNo: batchNo,
      weaccessRef: weaccessRef,
      successful: [],
      totalAmount: 0,
      failures: failureLog,
      jevParticulars: null,
      attachmentNames: attachments.map(b => b.getName())
    }),
    attachments: attachments,
    name: 'DAP E-Payment Notification (NO-REPLY)'
  });
}

/**
 * Accounting email in the same layout as the payee and authorizer emails. When jevParticulars is
 * null the batch had no successful transfers and the email says there is nothing to record.
 */
function _buildAccountingEmailHtml({ batchNo, weaccessRef, successful, totalAmount, failures, jevParticulars, attachmentNames }) {
  const fmt = n => (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const cell = 'padding: 10px; border: 1px solid #ddd;';
  const noPayments = !jevParticulars;
  const failedTotal = Math.round(failures.reduce((sum, f) => sum + (Number(f.amount) || 0), 0) * 100) / 100;

  let html = `
  <div style="font-family: Arial, sans-serif; font-size: 16px; color: #333; max-width: 700px; margin: auto; border: 1px solid #ddd;">
    <div style="background-color: #1C2790; padding: 20px; text-align: center;">
      <img src="https://i.imgur.com/jaEbfAR.png" alt="DAP Logo" style="width: 400px;">
    </div>
    <div style="padding: 25px; border-top: 5px solid #CDAE2C;">
      <h2 style="color: #1C2790; text-align: center; font-size: 22px; text-transform: uppercase;">${noPayments ? 'No Successful Transfers' : 'For Recording: E-Payment Batch'}</h2>
      <p>Good day,</p>
      <p>${noPayments
        ? `None of the transfers in e-payment batch <b>${batchNo}</b> went through. There is no e-payment to record; the debit memo and LandBank reports are attached for your information.`
        : `Please see the attached files for the completed e-payment batch <b>${batchNo}</b>.`}</p>
      <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
        <tr style="background-color: #f2f2f2;"><td style="${cell} font-weight: bold;">Batch Number:</td><td style="${cell} font-weight: bold; color: #1C2790;">${batchNo}</td></tr>
        <tr><td style="${cell} font-weight: bold;">WeAccess TRN:</td><td style="${cell}">${weaccessRef}</td></tr>
        <tr><td style="${cell} font-weight: bold;">Successful Transfers:</td><td style="${cell}">${successful.length}</td></tr>
        <tr><td style="${cell} font-weight: bold;">Total E-Payments:</td><td style="${cell} font-weight: bold; color: #1C2790;">PHP ${fmt(totalAmount)}</td></tr>
      </table>`;

  if (failures.length > 0) {
    html += `
      <h3 style="color: #C00000; margin-bottom: 8px;">Unsuccessful Transfers (${failures.length})</h3>
      <p style="margin-top: 0; font-size: 14px;">These DVs were not credited and have been returned to Treasury for re-batching. They are excluded from the total above.</p>
      <table style="width: 100%; border-collapse: collapse; font-size: 14px; margin-bottom: 15px;">
        <tr style="background-color: #f2f2f2;"><th style="${cell} text-align: left;">Payee</th><th style="${cell} text-align: left;">DV No.</th><th style="${cell} text-align: right;">Amount</th><th style="${cell} text-align: left;">Bank Remarks</th></tr>`;
    for (const f of failures) {
      html += `<tr><td style="${cell}">${f.payeeName}</td><td style="${cell}">${f.dvNo}</td><td style="${cell} text-align: right; color: #C00000;">${fmt(f.amount)}</td><td style="${cell}">${f.reason}</td></tr>`;
    }
    html += `</table>`;
    if (!noPayments) {
      html += `
      <table style="width: 100%; border-collapse: collapse; font-size: 14px; margin-bottom: 20px;">
        <tr><td style="padding: 4px 10px; text-align: right;">Total per Payroll Register / Debit Memo</td><td style="padding: 4px 10px; text-align: right; width: 140px;">${fmt(totalAmount + failedTotal)}</td></tr>
        <tr><td style="padding: 4px 10px; text-align: right;">Less: Unsuccessful transfers (${failures.length})</td><td style="padding: 4px 10px; text-align: right;">(${fmt(failedTotal)})</td></tr>
        <tr><td style="padding: 4px 10px; text-align: right; font-weight: bold;">Total e-payments (per bank statement)</td><td style="padding: 4px 10px; text-align: right; font-weight: bold; border-top: 1px solid #333;">${fmt(totalAmount)}</td></tr>
      </table>`;
    }
  }

  if (!noPayments) {
    // The particulars sit alone in their own block: one click selects them where the mail client
    // honours user-select, and a triple-click selects exactly this line everywhere else.
    html += `
      <p style="margin-bottom: 6px;"><b>JEV Particulars</b> <span style="font-size: 13px; color: #777;">(click or triple-click the box to select, then copy)</span></p>
      <div style="border: 2px dashed #1C2790; background-color: #f5f7ff; padding: 14px; border-radius: 5px; font-family: 'Courier New', monospace; font-size: 15px; color: #000; cursor: text; user-select: all; -webkit-user-select: all; -moz-user-select: all; -ms-user-select: all;">${jevParticulars}</div>`;
  }

  html += `
      <p style="margin-top: 25px; margin-bottom: 6px;"><b>Attached:</b></p>
      <ul style="margin-top: 0; font-size: 14px; color: #555;">${attachmentNames.map(n => `<li>${n}</li>`).join('')}</ul>
      <p style="margin-top: 30px;">Thank you,</p><p><b>Treasury Division</b></p>
    </div>
    <div style="text-align: center; font-size: 12px; color: #777; padding: 15px; background-color: #f9f9f9; border-top: 1px solid #ddd;"><p>This is an automated e-mail from the DAP E-Payment System. Please do not reply.</p></div>
  </div>`;
  return html;
}

// --- FOR BATCHING: CANCEL A DV ---

function _getSessionUser(token) {
  if (!token) return null;
  const session = CacheService.getScriptCache().get(`session_${token}`);
  if (!session) return null;
  const [email, role] = session.split(':');
  return { email: email, role: role };
}

/**
 * Cancels a DV that is still For Batching. The row is kept (status 'Cancelled', with reason,
 * user and date) so the DV number stays blocked from re-upload and the audit trail is intact.
 */
function cancelDvForWebApp(token, dvNo, reason) {
  try {
    const user = _getSessionUser(token);
    if (!user || (user.role !== 'Treasury' && user.role !== 'Admin')) {
      throw new Error('Only Treasury users can cancel a DV. Please log in again.');
    }
    if (!reason || !reason.toString().trim()) throw new Error('Please enter the reason for cancelling.');

    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Master_DV_List');
    const headers = _ensureMasterColumns(sheet);
    const data = sheet.getDataRange().getValues();
    const col = name => headers.indexOf(name);

    for (let i = 1; i < data.length; i++) {
      if (data[i][col('DV No')].toString() !== dvNo.toString()) continue;
      const status = data[i][col('Status')];
      if (status !== 'For Processing') {
        throw new Error(`DV ${dvNo} can no longer be cancelled (status: ${status}).`);
      }
      const rowNumber = i + 1;
      sheet.getRange(rowNumber, 1).setValue(false);
      sheet.getRange(rowNumber, col('Status') + 1).setValue('Cancelled');
      sheet.getRange(rowNumber, col('Cancel Reason') + 1).setValue(reason.toString().trim());
      sheet.getRange(rowNumber, col('Cancelled By') + 1).setValue(user.email);
      sheet.getRange(rowNumber, col('Cancelled On') + 1).setValue(new Date());
      return { success: true, message: `DV ${dvNo} has been cancelled and removed from For Batching.` };
    }
    throw new Error(`DV ${dvNo} was not found.`);
  } catch (e) {
    return { success: false, message: e.message };
  }
}
