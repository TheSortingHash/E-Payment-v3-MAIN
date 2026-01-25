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

  for (const row of data) {
    try {
      const status = row[statusCol];
      const batchNo = row[batchNoCol];
      const amount = parseFloat(row[amountCol]) || 0;
      
      const transaction = {
          payeeName: row[payeeNameCol],
          dvNo: row[dvNoCol],
          amount: amount,
          transType: row[transTypeCol]
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
    const recipient = 'gudoyj@dap.edu.ph,barawidana@dap.edu.ph,casalann@dap.edu.ph,dogeliop@dap.edu.ph,calinal@dap.edu.ph' ; // Replace with actual authorizer emails
    const ccrecipient = 'gonzagaj@dap.edu.ph,nolascom@dap.edu.ph,set@dap.edu.ph,medinor@dap.edu.ph,tomolingj@dap.edu.ph';
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

/**
 * Updates the status of transactions in a finalized batch.
 * The file moving part has been removed as it's now done in Stage 4a.
 * @param {string} batchNo The batch number to process.
 */
function updateStatusAndArchiveDvs(batchNo) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Master_DV_List');
  const dataRange = sheet.getRange('A2:O' + sheet.getLastRow());
  const data = dataRange.getValues();
  
  const statusCol = 1; // Column B
  const batchNoCol = 14; // Column O

  for (let i = 0; i < data.length; i++) {
    if (data[i][batchNoCol] === batchNo) {
      // Update status to the final state for Treasury
      sheet.getRange(i + 2, statusCol + 1).setValue('Approved & Emailed');
    }
  }
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
 */
function generateAnnexH(batchNo, weaccessRef, batchFolder) {
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

  for (const row of masterData) {
    if (row[batchNoColData] === batchNo) {
      const amount = row[amountCol];
      reportRows.push([
        batchDateStr, "N/A", weaccessRef, row[payeeNameCol], row[dvNoCol], 
        row[busNoCol], row[projectCodeCol], row[transTypeCol], amount
      ]);
      totalAmount += amount;
    }
  }

  if (reportRows.length > 0) {
    const dataStartRow = 7;
    if (reportRows.length > 1) {
        reportSheet.insertRowsBefore(dataStartRow + 1, reportRows.length - 1);
    }
    
    reportSheet.getRange(dataStartRow, 1, reportRows.length, 9).setValues(reportRows);
    
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

                const subject = `DAP Fund Transfer Confirmation (DV No. ${dvNo})`;

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

  // --- The logic for creating attachments and the email body remains the same ---
  const payeeNameCol = headers.indexOf('Payee Name');
  const amountCol = headers.indexOf('Amount Due');
  let csvContent = "Batch Number,WeAccess Ref No,Payee Name,Client Code,Amount\n";
  for (const row of batchTransactions) {
    const payeeName = row[payeeNameCol];
    const clientCode = clientCodeMap.get(payeeName) || 'NOT FOUND';
    csvContent += `${batchNo},${weaccessRef},"${payeeName}",${clientCode},${row[amountCol]}\n`;
  }
  const csvBlob = Utilities.newBlob(csvContent, MimeType.CSV, `Accounting Summary - ${batchNo}.csv`);

  const reportDate = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' });
  const jevParticulars = `Daily Report of E-Payments from Agency Account - Report No. ${batchNo} with TRN#${weaccessRef} dtd ${reportDate}`;

  const batchFolder = getBatchFolder(batchNo);
  const attachments = [csvBlob];
  const pdfFiles = batchFolder.getFilesByType(MimeType.PDF);
  while (pdfFiles.hasNext()) {
    attachments.push(pdfFiles.next().getBlob());
  }

  const recipient = 'padillaj@dap.edu.ph,baguim@dap.edu.ph,preciadosr@dap.edu.ph';
  const subject = `For Recording: E-Payment Batch ${batchNo}`;
  const htmlBody = `
    <p>Good day,</p>
    <p>Please see attached files for the completed e-payment batch <b>${batchNo}</b> with WeAccess TRN <b>${weaccessRef}</b>.</p>
    <p>This includes the Accounting Summary, Annex H, Debit Memo, and all supporting Disbursement Vouchers.</p>
    <br>
    <p>Please input the following particulars for your JEV Recording:</p>
    <div style="border: 1px solid #ccc; padding: 10px; background-color: #f9f9f9; border-radius: 5px; font-family: monospace;">
      ${jevParticulars}
    </div>
    <br>
    <p>This is an automated e-mail. Please do not reply. Thank you.</p>
  `;
  
  MailApp.sendEmail({
    to: recipient, subject: subject, htmlBody: htmlBody, attachments: attachments,
    name: 'DAP E-Payment Notification (NO-REPLY)'
  });
  
  const allSheetData = masterSheet.getRange("A2:P" + masterSheet.getLastRow()).getValues();
  for (let i = 0; i < allSheetData.length; i++) {
    if (allSheetData[i][batchNoCol] === batchNo) {
      masterSheet.getRange(i + 2, statusCol + 1).setValue('Completed');
    }
  }
  
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

    for (let i = 0; i < data.length; i++) {
        if (dvNumbers.includes(data[i][dvNoCol].toString())) {
            sheet.getRange(i + 2, statusCol + 1).setValue('Batched for Approval');
            sheet.getRange(i + 2, batchNoCol + 1).setValue(newBatchNumber);
        }
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
function generateFindesForWebApp(batchNo) {
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
function generateFindesForWebAppWithOverride(batchNo) {
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
function requestEndorsementForWebApp(batchNo, refNo, fileData) {
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

function notifyAccountingForWebApp(batchNo) {
    try {
        notifyAccounting(batchNo);
        return { success: true, message: `Accounting has been notified for batch ${batchNo}.` };
    } catch (e) {
        return { success: false, message: `Error: ${e.message}` };
    }
}
/**
 * Web app function for finalizing a batch.
 * This version handles the two file uploads from the dialog.
 */
function finalizeBatchForWebApp(batchNo, fileData) {
    try {
        const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Master_DV_List');
        const data = sheet.getDataRange().getValues();
        const headers = data.shift();
        const batchNoCol = headers.indexOf('Batch No');
        const refNoCol = headers.indexOf('WeAccess Ref No');
        let weaccessRef = '';

        for(const row of data){
            if(row[batchNoCol] === batchNo){
                weaccessRef = row[refNoCol];
                break;
            }
        }
        if (!weaccessRef) throw new Error("Could not find the WeAccess Reference Number for this batch.");
        
        finalizeBatch({ batchNo: batchNo, weaccessRef: weaccessRef, file: fileData });
        return { success: true, message: `Batch ${batchNo} has been finalized.` };
    } catch (e) {
        return { success: false, message: `Error: ${e.message}` };
    }
}


/**
 * Main orchestrator for Stage 5. Now reads the WeAccess TRN from the sheet.
 */
function finalizeBatch(dataObject) {
  const { batchNo, file } = dataObject;

  const batchFolder = getBatchFolder(batchNo);
  const fileBlob = Utilities.newBlob(Utilities.base64Decode(file.bytes), file.mimeType, file.name);
  batchFolder.createFile(fileBlob);

  // --- FIX: Read the saved WeAccess TRN from the sheet ---
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Master_DV_List');
  const data = sheet.getDataRange().getValues();
  const headers = data.shift();
  const batchNoCol = headers.indexOf('Batch No');
  const refNoCol = headers.indexOf('WeAccess Ref No');
  let weaccessRef = '';

  for(const row of data){
    if(row[batchNoCol] === batchNo){
      weaccessRef = row[refNoCol];
      break;
    }
  }

  if (!weaccessRef) {
      throw new Error("Could not find the WeAccess Reference Number for this batch in the sheet.");
  }

  generateAnnexH(batchNo, weaccessRef, batchFolder);
  updateStatusAndArchiveDvs(batchNo); // No longer needs weaccessRef
  sendPayeeEmails(batchNo);

  return `Success! Batch "${batchNo}" has been finalized. Annex H has been generated and emails have been sent.`;
}
