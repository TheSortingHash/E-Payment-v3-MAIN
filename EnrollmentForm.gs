/**
 * An installable trigger that runs when the enrollment form is submitted.
 * UPDATED to correctly read the endorser's email from the last column of the form response.
 * UPDATED to send an email notification to the admin upon submission.
 */
function onFormSubmit(e) {
    try {
        const ss = SpreadsheetApp.getActiveSpreadsheet();
        const formResponseSheet = ss.getSheetByName('Form Responses 1');
        
        const lastRow = formResponseSheet.getLastRow();
        const responseData = formResponseSheet.getRange(lastRow, 1, 1, formResponseSheet.getLastColumn()).getValues()[0];

        // --- FIX: Read the data from the correct columns ---
        const timestamp = responseData[0];
        const surname = responseData[1];
        const firstName = responseData[2];
        const middleName = responseData[3];
        const lbpAccount = responseData[4];
        const lbpBranch = responseData[5];
        const email = responseData[6];         // Payee's email
        const annexAFileLink = responseData[7];
        const proofFileLink = responseData[8];
        const endorserEmail = responseData[9]; // Endorser's email from Column J

        let proofUrl = '';
        let annexUrl = '';

        const getFileIdFromUrl = (url) => {
            if (url && typeof url === 'string') {
                const match = url.match(/id=([^&]+)/);
                return match ? match[1] : null;
            }
            return null;
        };

        const proofFileId = getFileIdFromUrl(proofFileLink);
        const annexFileId = getFileIdFromUrl(annexAFileLink);
        
        if (proofFileId) {
            const proofFile = DriveApp.getFileById(proofFileId);
            const newProofName = `BankProof_${surname}_${firstName}.${proofFile.getName().split('.').pop()}`;
            proofFile.setName(newProofName);
            proofUrl = proofFile.getUrl();
        }
        if (annexFileId) {
            const annexFile = DriveApp.getFileById(annexFileId);
            const newAnnexName = `AnnexA_${surname}_${firstName}.${annexFile.getName().split('.').pop()}`;
            annexFile.setName(newAnnexName);
            annexUrl = annexFile.getUrl();
        }

        const enrollmentSheet = ss.getSheetByName('Enrollment_Requests');
        
        // Append the new row with the Endorser_Email in the correct column
        enrollmentSheet.appendRow([
            timestamp,
            'Pending HR Validation', // Status
            surname,
            firstName,
            middleName,
            lbpAccount,
            lbpBranch,
            email,
            annexUrl,
            proofUrl,
            '', // HRIS_Formatted_Name
            '', // HRIS_Number
            '', // Notes
            '', // Date_Approved
            endorserEmail // Endorser_Email
        ]);

        // --- NEW: Send Notification to Admin (anchetad@dap.edu.ph) ---
        const adminEmail = 'anchetad@dap.edu.ph';
        const subject = `New Enrollment Request: ${surname}, ${firstName}`;
        const htmlBody = `
            <div style="font-family: Arial, sans-serif; font-size: 16px; color: #333; max-width: 600px; margin: auto; border: 1px solid #ddd;">
                <div style="background-color: #1C2790; padding: 20px; text-align: center;">
                    <h2 style="color: white; margin: 0;">E-PAYMENT SYSTEM</h2>
                </div>
                <div style="padding: 25px; border-top: 5px solid #CDAE2C;">
                    <h3 style="color: #1C2790; margin-top: 0;">New Enrollment Request Received</h3>
                    <p>A new payee enrollment request has been submitted and is pending your validation.</p>
                    <table style="width: 100%; border-collapse: collapse; margin-top: 15px; margin-bottom: 15px;">
                        <tr><td style="padding: 8px; border-bottom: 1px solid #ddd; font-weight: bold;">Payee Name:</td><td style="padding: 8px; border-bottom: 1px solid #ddd;">${surname}, ${firstName} ${middleName}</td></tr>
                        <tr><td style="padding: 8px; border-bottom: 1px solid #ddd; font-weight: bold;">Endorsed By:</td><td style="padding: 8px; border-bottom: 1px solid #ddd;">${endorserEmail}</td></tr>
                        <tr><td style="padding: 8px; border-bottom: 1px solid #ddd; font-weight: bold;">Date Submitted:</td><td style="padding: 8px; border-bottom: 1px solid #ddd;">${timestamp}</td></tr>
                    </table>
                    <p>Please log in to the <b>Admin Dashboard</b> (External Enrollment Tab) to review the submitted documents and validate this request.</p>
                    <p style="margin-top: 20px;">Thank you,</p>
                    <p><b>System Automated Notification</b></p>
                </div>
            </div>
        `;

        MailApp.sendEmail({
            to: adminEmail,
            subject: subject,
            htmlBody: htmlBody
        });
        // --- END NEW CODE ---

    } catch (error) {
        Logger.log(`Error in onFormSubmit: ${error.toString()}`);
    }
}

// --- ADMIN WEB APP FUNCTIONS ---

function addPayee(payeeData) {
    const lock = LockService.getScriptLock();
    // Wait up to 5 seconds for other processes to finish
    if (!lock.tryLock(5000)) {
        return "Error: System is busy. Please do not double-click the add button.";
    }

    try {
        const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Payee_Database');
        const data = sheet.getDataRange().getValues(); // Get all current payees
        
        // Normalize inputs for comparison (trim spaces, uniform case)
        const newName = payeeData.name.toString().trim().toUpperCase();
        const newAccount = payeeData.account.toString().trim();

        // Check for duplicates
        for (let i = 1; i < data.length; i++) { // Start at 1 to skip headers
            const existingName = data[i][0].toString().trim().toUpperCase();
            const existingAccount = data[i][1].toString().trim();

            if (existingName === newName) {
                return `Error: The payee "${payeeData.name}" already exists in the database.`;
            }
            // Check account uniqueness only if the new account is not empty/placeholder
            if (newAccount.length > 5 && existingAccount === newAccount) {
                return `Error: The account number ${payeeData.account} is already assigned to ${data[i][0]}.`;
            }
        }

        // If no duplicates found, proceed to add
        sheet.appendRow([payeeData.name, payeeData.account, payeeData.email, payeeData.hris]);
        _sortPayeeDatabase();
        return `Successfully added payee: ${payeeData.name}`;

    } catch (e) {
        return `Error adding payee: ${e.message}`;
    } finally {
        lock.releaseLock(); // Always release the lock
    }
}


function updatePayee(originalName, payeeData) {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(5000)) {
        return "Error: System is busy. Please try again.";
    }

    try {
        const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Payee_Database');
        const lastRow = sheet.getLastRow();
        
        if (lastRow < 2) {
             return `Error: Database is empty.`;
        }

        // Get all data to check both Names (for finding the row) and Accounts (for conflict)
        const data = sheet.getRange('A2:D' + lastRow).getValues();
        
        const newAccount = payeeData.account.toString().trim();
        const newName = payeeData.name.toString().trim();
        let targetRowIndex = -1;

        // Iterate through the database
        for (let i = 0; i < data.length; i++) {
            const rowName = data[i][0];
            const rowAccount = data[i][1].toString().trim();

            // Case 1: We found the row we are supposed to update
            if (rowName === originalName) {
                targetRowIndex = i;
                continue; // Skip the conflict check for the row we are modifying itself
            }

            // Case 2: Conflict Check - Does another person already have this account number?
            // We only check if the account number is substantial (more than 5 digits)
            if (newAccount.length > 5 && rowAccount === newAccount) {
                return `Error: Update Failed. The account number ${payeeData.account} is already registered to "${rowName}".`;
            }
        }

        if (targetRowIndex === -1) {
            return `Error: Could not find original payee "${originalName}" to update.`;
        }

        // If we passed the loop, no conflicts exist. Proceed to update.
        // +2 adjustment: 0-based index + 1 for header + 1 for 1-based row count
        sheet.getRange(targetRowIndex + 2, 1, 1, 4).setValues([[payeeData.name, payeeData.account, payeeData.email, payeeData.hris]]);
        _sortPayeeDatabase();
        
        return `Successfully updated payee: ${payeeData.name}`;

    } catch (e) {
        return `Error updating payee: ${e.message}`;
    } finally {
        lock.releaseLock();
    }
}

// --- ADMIN WEB APP FUNCTIONS ---

function getPayees() {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Payee_Database');
    const lastRow = sheet.getLastRow();

    // SAFETY CHECK: If only headers exist (row 1) or sheet is empty, return empty list immediately.
    if (lastRow < 2) {
        return []; 
    }

    const data = sheet.getRange('A2:D' + lastRow).getValues();
    return data.map(row => ({ name: row[0], account: row[1], email: row[2], hris: row[3] }));
}

function _sortPayeeDatabase() {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Payee_Database');
    const lastRow = sheet.getLastRow();

    // SAFETY CHECK: Do not try to sort if there is no data (only headers).
    if (lastRow < 2) {
        return;
    }

    const range = sheet.getRange('A2:D' + lastRow);
    range.sort({ column: 1, ascending: true });
}

// --- EXTERNAL ENROLLMENT DASHBOARD FUNCTIONS ---

/**
 * Fetches all pending enrollment requests for the Admin Web App.
 * It separates requests for HR and for the final Admin approval.
 */
function getEnrollmentRequests() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Enrollment_Requests');
  const data = sheet.getDataRange().getValues();
  const headers = data.shift();
  
  const pendingHr = [];
  const pendingAdmin = [];

  const statusCol = headers.indexOf('Status');
  const timestampCol = headers.indexOf('Timestamp');

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const status = row[statusCol];
    const request = {};
    
    // Create a data object from the row using headers as keys
    headers.forEach((header, index) => {
      // Format date objects for display
      if (row[index] instanceof Date) {
        request[header] = row[index].toLocaleString('en-US', { timeZone: 'Asia/Manila' });
      } else {
        request[header] = row[index];
      }
    });
    request.rowIndex = i + 2; // Store the original row number for easy updates

    if (status === 'Pending HR Validation') {
      pendingHr.push(request);
    } else if (status === 'Pending Final Approval') {
      pendingAdmin.push(request);
    }
  }
  
  return { pendingHr, pendingAdmin };
}


/**
 * Called by an HR user from the Admin Web App.
 * Updates an enrollment request with HRIS info and changes its status.
 */
function submitRequestToAdmin(rowIndex, hrisName, hrisNumber) {
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Enrollment_Requests');
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    
    const statusCol = headers.indexOf('Status') + 1;
    const hrisNameCol = headers.indexOf('HRIS_Formatted_Name') + 1;
    const hrisNumberCol = headers.indexOf('HRIS_Number') + 1;

    sheet.getRange(rowIndex, statusCol).setValue('Pending Final Approval');
    sheet.getRange(rowIndex, hrisNameCol).setValue(hrisName);
    sheet.getRange(rowIndex, hrisNumberCol).setValue(hrisNumber);

    return { success: true, message: 'Request submitted to System Administrator for final approval.' };
  } catch(e) {
    return { success: false, message: e.message };
  }
}


/**
 * Called by the System Admin to give final approval to an enrollment request.
 * UPDATED with LockService and Duplicate Checks to prevent double-enrollment.
 */
function approveAndEnrollPayee(requestData) {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(5000)) {
        return { success: false, message: "System is processing. Please do not double-click." };
    }

    try {
        const payeeSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Payee_Database');
        const data = payeeSheet.getDataRange().getValues();

        // Normalize inputs
        const newName = requestData.HRIS_Formatted_Name.toString().trim().toUpperCase();
        const newAccount = requestData.LBP_Account_Number.toString().trim();

        // Check for duplicates in Payee Database
        for (let i = 1; i < data.length; i++) {
            const existingName = data[i][0].toString().trim().toUpperCase();
            const existingAccount = data[i][1].toString().trim();

            if (existingName === newName) {
                 return { success: false, message: `Error: ${requestData.HRIS_Formatted_Name} is already enrolled in the Payee Database.` };
            }
            if (newAccount.length > 5 && existingAccount === newAccount) {
                 return { success: false, message: `Error: Account number ${requestData.LBP_Account_Number} is already in use by ${data[i][0]}.` };
            }
        }

        // Append to Database
        payeeSheet.appendRow([
            requestData.HRIS_Formatted_Name,
            requestData.LBP_Account_Number,
            requestData.Email_Address,
            requestData.HRIS_Number
        ]);
        _sortPayeeDatabase();

        // Update Status in Enrollment_Requests
        const requestSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Enrollment_Requests');
        const headers = requestSheet.getRange(1, 1, 1, requestSheet.getLastColumn()).getValues()[0];
        const statusCol = headers.indexOf('Status') + 1;
        const dateApprovedCol = headers.indexOf('Date_Approved') + 1;
        
        requestSheet.getRange(requestData.rowIndex, statusCol).setValue('Enrolled');
        requestSheet.getRange(requestData.rowIndex, dateApprovedCol).setValue(new Date());

        // Send Confirmation
        _sendEnrollmentConfirmationEmail(requestData, requestData.Endorser_Email);

        return { success: true, message: `Successfully enrolled ${requestData.HRIS_Formatted_Name}. A confirmation email has been sent.` };

    } catch(e) {
        return { success: false, message: e.message };
    } finally {
        lock.releaseLock();
    }
}


/**
 * A helper function to send a confirmation email to a newly enrolled payee.
 * UPDATED to CC the endorsing project team member and format the account number.
 */
function _sendEnrollmentConfirmationEmail(payeeData, endorserEmail) {
    const subject = 'DAP E-Payment System Enrollment Confirmation';
    
    // Combine the CC recipients
    const ccRecipients = ['cashtreasury@dap.edu.ph'];
    if (endorserEmail) {
        ccRecipients.push(endorserEmail);
    }
    
    // --- NEW: Format the account number to ensure 10 digits with leading zeros ---
    const formattedAccountNo = payeeData.LBP_Account_Number.toString().padStart(10, '0');
    
    const htmlBody = `
        <div style="font-family: Arial, sans-serif; font-size: 16px; color: #333; max-width: 600px; margin: auto; border: 1px solid #ddd;">
            <div style="background-color: #1C2790; padding: 20px; text-align: center;">
                <img src="https://i.imgur.com/jaEbfAR.png" alt="DAP Logo" style="width: 400px;">
            </div>
            <div style="padding: 25px; border-top: 5px solid #CDAE2C;">
                <h2 style="color: #1C2790; text-align: center; font-weight: bold; text-transform: uppercase;">NOTICE OF SUCCESSFUL ENROLLMENT</h2>
                <p>Dear <b>${payeeData.HRIS_Formatted_Name}</b>,</p>
                <p>Greetings! This email confirms that your Landbank Account has been officially enrolled in the DAP's E-Payment System. Please see your enrolled details below for verification:</p>
                <table style="width: 100%; border-collapse: collapse; margin-top: 25px; margin-bottom: 25px;">
                  <tr style="background-color: #f2f2f2;"><td style="padding: 12px; border: 1px solid #ddd; font-weight: bold;">DAP HRIS Name:</td><td style="padding: 12px; border: 1px solid #ddd;">${payeeData.HRIS_Formatted_Name}</td></tr>
                  <tr><td style="padding: 12px; border: 1px solid #ddd; font-weight: bold;">Landbank Account Number:</td><td style="padding: 12px; border: 1px solid #ddd;">${formattedAccountNo}</td></tr>
                  <tr><td style="padding: 12px; border: 1px solid #ddd; font-weight: bold;">Registered Email:</td><td style="padding: 12px; border: 1px solid #ddd;">${payeeData.Email_Address}</td></tr>
                </table>
                <p>You will now receive your professional fee payments from DAP via this nominated account.</p>
                <p>An electronically signed copy of your BIR Form 2307 will be sent to your registered email address along with each fund transfer confirmation.</p>
                <p>Thank you,</p>
                <p><b>Finance Department</b></p>
            </div>
            <div style="text-align: center; font-size: 12px; color: #777; padding: 15px; background-color: #f9f9f9; border-top: 1px solid #ddd;"><p>This is an automated notification. Your reply will be sent to the DAP Treasury Division.</p></div>
        </div>
    `;

    MailApp.sendEmail({
        to: payeeData.Email_Address,
        cc: ccRecipients.join(','),
        bcc: 'anchetad@dap.edu.ph',
        subject: subject,
        htmlBody: htmlBody,
        name: 'DAP E-Payment System',
        replyTo: 'cashtreasury@dap.edu.ph'
    });
}

// --- SDO MANAGEMENT FUNCTIONS ---

/**
 * Fetches the list of all enrolled SDO PCF accounts for the Admin Web App.
 */
function getSdoAccounts() {
    try {
        const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('SDO_PCF_Accounts');
        if (!sheet || sheet.getLastRow() < 2) {
            return []; // Return an empty array if the sheet doesn't exist or has no data
        }
        const data = sheet.getRange('A2:B' + sheet.getLastRow()).getValues();
        return data.map(row => ({ name: row[0], account: row[1] }));
    } catch (e) {
        // In case of an error, return an empty array to prevent the web app from crashing.
        Logger.log(`Error in getSdoAccounts: ${e.message}`);
        return [];
    }
}

/**
 * Adds or updates an SDO's PCF account in the SDO_PCF_Accounts sheet.
 * @param {string} payeeName The name of the SDO.
 * @param {string} pcfAccount The dedicated PCF account number.
 * @return {string} A success or failure message.
 */
function addSdoAccount(payeeName, pcfAccount) {
    try {
        if (!payeeName || !pcfAccount) {
            throw new Error("Payee Name and PCF Account Number cannot be empty.");
        }
        const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('SDO_PCF_Accounts');
        const data = sheet.getRange('A:A').getValues().flat();
        
        const existingRowIndex = data.indexOf(payeeName);

        if (existingRowIndex > -1) {
            // If the SDO already exists, update their account number
            sheet.getRange(existingRowIndex + 1, 2).setValue(pcfAccount);
            return `Successfully updated PCF account for ${payeeName}.`;
        } else {
            // If the SDO is new, add them to the list
            sheet.appendRow([payeeName, pcfAccount]);
            // Sort the sheet by Payee Name after adding a new entry
            const range = sheet.getRange('A2:B' + sheet.getLastRow());
            range.sort({ column: 1, ascending: true });
            return `Successfully enrolled ${payeeName} as an SDO.`;
        }
    } catch (e) {
        Logger.log(`Error in addSdoAccount: ${e.message}`);
        // We throw the error so the front-end can display it in an alert
        throw new Error(`Failed to enroll SDO: ${e.message}`);
    }
}
