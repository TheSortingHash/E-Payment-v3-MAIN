// ==========================================
// --- TRANCHE 1: PROCESS & EXTRACT ---
// ==========================================

function processUploadedPdf(dataObject) {
  // Legacy function for standard upload (non-web app) if needed
  // Reusing the Web App logic to ensure consistency
  return processUploadedPdfForWebApp(dataObject).message; 
}

function processUploadedPdfForWebApp(dataObject) {
  const { name, mimeType, file: fileBytes } = dataObject;
  let tempPdfFile = null;

  try {
    const fileBlob = Utilities.newBlob(Utilities.base64Decode(fileBytes), mimeType, name);
    const config = getConfiguration();
    
    const incomingFolder = DriveApp.getFolderById(config.incomingFolderId);
    tempPdfFile = incomingFolder.createFile(fileBlob);
    const tempPdfId = tempPdfFile.getId();

    // 1. OCR & Extraction
    const ocrTextForCheck = performOcrOnPdf(tempPdfId);
    const extractedData = extractDataFromText(ocrTextForCheck);
    const dvNumberToCheck = extractedData['DV No'];

    // 2. Duplicate Check
    if (!dvNumberToCheck || dvNumberToCheck === 'NOT FOUND') {
      throw new Error('Could not read the DV Number from the PDF. Please check quality.');
    }
    if (isDuplicate(dvNumberToCheck)) {
      throw new Error(`Duplicate Found: DV No. "${dvNumberToCheck}" already exists.`);
    }

    // 3. Classification
    const particularsText = extractedData['Particulars Text'];
    const transactionType = getTransactionType(particularsText);
    
    if (transactionType === 'Unclassified') {
      throw new Error('Upload Rejected: Transaction not eligible for e-payment.');
    }
    extractedData['Transaction Type'] = transactionType;
    
    // 4. Upfront Payee Validation
    const payeeName = extractedData['Payee Name'];
    if (transactionType.includes('Professional Fee') || transactionType.includes('Honoraria')) {
       const payeeDbSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Payee_Database');
       const payeeNames = payeeDbSheet.getRange('A2:A').getValues().flat();
       if (!payeeNames.includes(payeeName)) {
         throw new Error(`Upload Rejected: The payee "${payeeName}" is not yet enrolled.`);
       }
    } else if (transactionType.includes('Petty Cash') || transactionType.includes('Revolving Fund')) {
      const sdoSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('SDO_PCF_Accounts');
      const sdoNames = sdoSheet.getRange('A2:A').getValues().flat();
      if (!sdoNames.includes(payeeName)) {
        throw new Error(`Upload Rejected: The payee "${payeeName}" is not an enrolled SDO.`);
      }
    }

    // 5. Log to Master DV List
    logDataToSheet(extractedData, tempPdfFile);

    // 6. Tax Cert Extraction (Tranche 1)
    if (transactionType.includes('Professional Fee')) {
        const taxData = analyzeJevForTax(ocrTextForCheck);
        
        // Prepare full record for Tax Sheet
        const fullTaxRecord = {
            ...extractedData,
            ...taxData,
            'PDF Link': tempPdfFile.getUrl()
        };
        
        logTaxCertData(fullTaxRecord);
    }

    // 7. File Filing
    const processedFolder = DriveApp.getFolderById(config.processedFolderId);
    tempPdfFile.setName(`${extractedData['Payee Name']} - ${extractedData['DV No']}.pdf`).moveTo(processedFolder);
    tempPdfFile = null;

    return { 
      isError: false, 
      message: `Success! DV for ${extractedData['Payee Name']} logged as "${transactionType}".`,
      data: { 
        payee: extractedData['Payee Name'], 
        dv: extractedData['DV No'],
        amount: extractedData['Amount Due']
      }
    };
    
  } catch (e) {
    return { isError: true, message: `${e.message}` };
  } finally {
    if (tempPdfFile) tempPdfFile.setTrashed(true);
  }
}

// --- HELPER FUNCTIONS ---

function getConfiguration() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Config'); // Hardcoded name to be safe
  const data = sheet.getRange('A2:B' + sheet.getLastRow()).getValues();
  const config = {};
  data.forEach(row => {
    if (row[0] && row[1]) config[row[0].trim()] = row[1].trim();
  });
  return config;
}

function performOcrOnPdf(pdfId) {
  try {
    const resource = {
      title: `temp_ocr_${new Date().getTime()}`,
      mimeType: 'application/vnd.google-apps.document'
    };
    const tempDoc = Drive.Files.copy(resource, pdfId, { fields: 'id' });
    const text = DocumentApp.openById(tempDoc.id).getBody().getText();
    Drive.Files.remove(tempDoc.id);
    return text;
  } catch (e) {
    throw new Error('OCR Failed: ' + e.message);
  }
}

function extractDataFromText(text) {
  const data = {};
  const patterns = {
    'PC No': /PC No:\s*(\S+)/,
    'DV No': /DV No\.\s*([\d-]+)/,
    'BUS No': /BUS No\.\s*(\S+)/,
    'Payee Name': /Payee:\s*([^\n]+)/,
    'Amount Due': /Amount Due[=\s>]*([\d,]+\.\d{2})/,
    'Project Code': /Project Code:\s*(\S+)/,
    'JEV No': /JEV Number:\s*([\d-]+)/,
    'Date Processed': /Date\/Time Processed\/Updated:\s*([^\s\/]+)/,
    'Particulars Text': /Particulars\s*([\s\S]*?)Amount Due/,
    // Tax Cert Fields
    'Address': /Address:\s*([\s\S]*?)TIN/,
    'TIN': /TIN No:\s*([\d-]+)/
  };

  for (const key in patterns) {
    const match = text.match(patterns[key]);
    if ((key === 'Particulars Text' || key === 'Address') && match) {
      data[key] = match[1].replace(/\s+/g, ' ').trim();
    } else {
      data[key] = match ? match[1].trim() : 'NOT FOUND';
    }
  }
  return data;
}

function isDuplicate(dvNumber) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Master_DV_List');
  if (sheet.getLastRow() < 2) return false;
  
  const headers = sheet.getRange('A1:P1').getValues()[0];
  const dvColumnIndex = headers.indexOf('DV No');
  
  if (dvColumnIndex === -1) throw new Error("Column 'DV No' missing in Master List.");
  
  const dvColumn = sheet.getRange(2, dvColumnIndex + 1, sheet.getLastRow() - 1, 1).getValues();
  return dvColumn.some(row => row[0] && row[0].toString().trim() === dvNumber.toString().trim());
}

function logDataToSheet(data, file) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Master_DV_List');
  const nextRow = sheet.getLastRow() + 1;
  
  const newRowData = [[
    false, 'For Processing', new Date(), 
    data['PC No'], data['DV No'], data['BUS No'], data['Payee Name'],
    parseFloat(data['Amount Due'].replace(/,/g, '')), 
    data['Project Code'], data['JEV No'], data['Date Processed'],
    data['Transaction Type'], data['Particulars Text'], file.getUrl(), '', ''
  ]];

  sheet.getRange(nextRow, 1, 1, 16).setValues(newRowData);
  sheet.getRange(nextRow, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
}

function getTransactionType(particularsText) {
    const originalText = particularsText || ''; 
    const particulars = originalText.toLowerCase(); 
    let transactionType = 'Unclassified';

    if (originalText.includes('EME')) transactionType = 'Extraordinary and Misc. Expenses';
    else if (particulars.includes('liq/reim of ca') || particulars.includes('liq/reimb of ca')) transactionType = 'Liquidation/Reimbursement of Cash Advance';
    else if (particulars.includes('reimb')) transactionType = 'Reimbursement of Expenses';
    else if (particulars.includes('petty cash')) transactionType = 'Replenishment of Petty Cash Funds';
    else if (particulars.includes('cash advance') && particulars.includes('travel')) transactionType = 'Cash Advance for Travel';
    else if (particulars.includes('cash advance')) transactionType = 'Cash Advance for Specific Purposes';
    else if (particulars.includes('cash payroll')) transactionType = 'Cash Payroll';
    else if (particulars.includes('establishment of revolving fund')) transactionType = 'Establishment of Revolving Fund';
    else if (particulars.includes('salary differential - promotion')) transactionType = 'Special Payroll: Salary Differential due to Promotion';
    else if (particulars.includes('clothing allowance')) transactionType = 'Special Payroll: Clothing Allowance';
    else if (particulars.includes('cpcs')) transactionType = 'Special Payroll:Salary Differential due to CPCS Implementation';
    else if (particulars.includes('resource person')) transactionType = 'Professional Fee - Resource Person';
    else if (particulars.includes('consultancy')) transactionType = 'Professional Fee - Consultancy Services';
    else if (particulars.includes('loyalty')) transactionType = 'Loyalty Pay';
    else if (particulars.includes('npp')) transactionType = 'Unclaimed Salary - NPP';

    return transactionType;
}

// ==========================================
// --- TRANCHE 1: JEV ANALYSIS ---
// ==========================================

/**
 * Analyzes the full OCR text to find specific JEV Account Codes and Amounts.
 * Implements the "Hybrid Mapping" logic to determine ATC.
 * UPDATED: Uses JEV Date for period coverage (instead of Processed Date).
 */
function analyzeJevForTax(text) {
    // Helper to extract amount by Account Code
    const getAmountForCode = (code) => {
        // Look for the Code, followed by any text, then the first number format it finds
        const regex = new RegExp(`${code}[\\s\\S]*?([\\d,]+\\.\\d{2})`);
        const match = text.match(regex);
        return match ? parseFloat(match[1].replace(/,/g, '')) : 0.00;
    };

    // --- FIX 1: Search Multiple Expense Codes for Tax Base ---
    // Add any other Expense Account Codes you encounter here
    const possibleBaseCodes = [
        '5-02-11-990-01', // Other Professional Services
        '5-02-11-030-01'  // Consultancy Services (Found in your DV)
    ];

    let baseAmount = 0.00;
    for (const code of possibleBaseCodes) {
        const amount = getAmountForCode(code);
        if (amount > 0) {
            baseAmount = amount;
            break; // Stop once we find a valid base
        }
    }

    const ewtAmount = getAmountForCode('2-02-01-010-02');
    const vatAmount = getAmountForCode('2-02-01-010-06'); // GMP-VAT
    const ptaxAmount = getAmountForCode('2-02-01-010-09'); // Percentage Tax

    // Determine ATC Code based on Rate
    let atcCode = '';
    if (baseAmount > 0 && ewtAmount > 0) {
        const rate = ewtAmount / baseAmount;
        // Check for 5% (allow small rounding difference)
        if (Math.abs(rate - 0.05) < 0.005) {
            atcCode = 'WI050';
        } 
        // Check for 10%
        else if (Math.abs(rate - 0.10) < 0.005) {
            atcCode = 'WI051';
        } 
        else {
            atcCode = 'REVIEW';
        }
    }

    // --- Extract JEV Date explicitly ---
    const jevDateMatch = text.match(/JEV Number:[\s\S]*?Date:\s*(\d{4}-\d{2}-\d{2})/);
    const jevDate = jevDateMatch ? jevDateMatch[1] : '';

    // Calculate Quarter/Period based on JEV Date
    let periodInfo = { start: '', end: '' };
    if (jevDate) {
        const dateObj = new Date(jevDate);
        const year = dateObj.getFullYear();
        const month = dateObj.getMonth(); // 0-11
        
        const quarter = Math.floor(month / 3);
        const startMonth = (quarter * 3) + 1;
        const endMonth = startMonth + 2;
        
        const fStart = `${String(startMonth).padStart(2, '0')}/01/${year}`;
        const lastDay = new Date(year, endMonth, 0).getDate();
        const fEnd = `${String(endMonth).padStart(2, '0')}/${lastDay}/${year}`;
        
        periodInfo = { start: fStart, end: fEnd };
    }

    return {
        'Tax Base': baseAmount,
        'EWT Amount': ewtAmount,
        'VAT Amount': vatAmount,
        'PTax Amount': ptaxAmount,
        'ATC Code': atcCode,
        'JEV Date': jevDate, 
        'Period Start': periodInfo.start,
        'Period End': periodInfo.end
    };
}

function logTaxCertData(data) {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName('Tax_Cert_Data');

    if (!sheet) {
        sheet = ss.insertSheet('Tax_Cert_Data');
        // Updated Headers with JEV Date at Index 14 (Column O)
        const headers = [
            'DV No', 'Payee Name', 'Address', 'TIN', 
            'Tax Base', 'EWT Amount', 'VAT Amount', 'PTax Amount', 
            'ATC Code', 'Period Start', 'Period End', 'Status', 'PDF Link', 'Tax Cert Link', 'JEV Date'
        ];
        sheet.getRange('A1:O1').setValues([headers]).setFontWeight('bold').setBackground('#f3f3f3');
    }

    // If existing sheet, check if Column O exists/is header. If strictly needed, we assume user added it or script appends.
    // For safety, we just write to the range.
    
    const lastRow = sheet.getLastRow();
    const rowData = [
        data['DV No'], data['Payee Name'], data['Address'], data['TIN'],
        data['Tax Base'], data['EWT Amount'], data['VAT Amount'], data['PTax Amount'],
        data['ATC Code'], data['Period Start'], data['Period End'],
        'Draft', data['PDF Link'], '', data['JEV Date'] // Added JEV Date at end
    ];
    
    // Write 15 columns now
    sheet.getRange(lastRow + 1, 1, 1, 15).setValues([rowData]);
}

// ==========================================
// --- TRANCHE 2: GENERATOR & APPROVAL ---
// ==========================================

const TAX_TEMPLATE_ID = '1vgvObxctWAM2ixQA3wDIcbF6gcs6Y6PC4YdsE4MBJrk'; 
const SIGNATURE_FILE_ID = '1MGB6LX0n2QnOfdItvVn8nJeI3x29dkAn'; 
const ACCOUNTANT_EMAIL = 'preciadosr@dap.edu.ph';

function generateTaxCert(dvNo, isFinal = false) {
  let tempFile = null;
  
  try {
    // 1. Fetch Data from Tax Sheet
    const data = getTaxDataByDv(dvNo);
    if (!data) throw new Error(`No tax data found for DV ${dvNo}`);

    // --- FIX: Fetch Missing Info from Master List ---
    const masterData = getMasterDvData(dvNo);
    if (masterData) {
        data['JEV No'] = masterData['JEV No'];
        data['Project Code'] = masterData['Project Code'];
    }
    // -----------------------------------------------
    
    console.log("Generating Cert for:", data); 

    // 2. Prepare Template
    const templateFile = DriveApp.getFileById(TAX_TEMPLATE_ID);
    const config = getConfiguration();
    const targetFolder = DriveApp.getFolderById(config.processedFolderId); 
    
    const tempName = `2307_${isFinal ? 'FINAL' : 'DRAFT'}_${data['Payee Name']}_${dvNo}`;
    tempFile = templateFile.makeCopy(tempName, targetFolder);
    const tempSs = SpreadsheetApp.open(tempFile);
    const sheet = tempSs.getSheets()[0];
    const sheetId = sheet.getSheetId().toString();

    // 3. Map Data
    fillTaxCertTemplate(sheet, data, isFinal);
    SpreadsheetApp.flush(); 
    
    // Critical Pause
    Utilities.sleep(2000); 

    // 4. PDF EXPORT
    let pdfBlob = null;
    
    try {
      const url = "https://docs.google.com/spreadsheets/d/" + tempSs.getId() + "/export" +
        "?format=pdf" +
        "&gid=" + sheetId +
        "&size=legal" +       
        "&portrait=true" +    
        "&scale=4" +          
        "&sheetnames=false&printtitle=false&pagenumbers=false&gridlines=false&fzr=false" +
        "&top_margin=0.50&bottom_margin=0.50&left_margin=0.50&right_margin=0.50";

      const options = {
        headers: { 'Authorization': 'Bearer ' + ScriptApp.getOAuthToken() },
        muteHttpExceptions: true 
      };
      
      const response = UrlFetchApp.fetch(url, options);
      
      if (response.getResponseCode() === 200) {
        pdfBlob = response.getBlob().setName(tempName + ".pdf");
      } else {
        console.warn("Export Failed Code: " + response.getResponseCode());
        throw new Error("Google Export API Error"); 
      }

    } catch (exportError) {
      console.log("Fallback to Standard Export");
      pdfBlob = tempSs.getAs(MimeType.PDF).setName(tempName + ".pdf");
    }

    const pdfFile = targetFolder.createFile(pdfBlob);
    updateTaxCertLink(dvNo, pdfFile.getUrl(), isFinal ? 'Approved' : 'Draft');

    return { success: true, url: pdfFile.getUrl() };

  } catch (e) {
    return { success: false, message: "Gen Error: " + e.message };
  } finally {
    if (tempFile) tempFile.setTrashed(true);
  }
}

/**
 * Helper: Fills the sheet with data based on the blueprint mapping.
 * UPDATED: Adds prefixes (JEV No:, DV No:, ProjCode:) to reference fields.
 * UPDATED: Uses JEV Date for column logic (Tranche 5 Fix).
 */
function fillTaxCertTemplate(sheet, data, isFinal) {
  // --- A. HEADER INFO ---
  
  // 1. Period From (MM/DD/YYYY) -> K11, M11, O11
  splitDateToCells(sheet, data['Period Start'], 'K11', 'M11', 'O11');
  
  // 2. Period To (MM/DD/YYYY) -> AB11, AD11, AF11
  splitDateToCells(sheet, data['Period End'], 'AB11', 'AD11', 'AF11');

  // 3. Payee TIN (4 parts) -> N15, R15, U15, Y15
  splitTinToCells(sheet, data['TIN'], 'N15', 'R15', 'U15', 'Y15');

  // 4. Basic Details
  sheet.getRange('B17').setValue(data['Payee Name']);
  sheet.getRange('B20').setValue(data['Address']); // Registered Address

  // --- B. REFERENCE DATA (With Labels) ---
  // We combine the Label String with the Data Value
  sheet.getRange('A41').setValue("JEV No.: " + (data['JEV No'] || ''));
  sheet.getRange('A42').setValue("DV No.: " + (data['DV No'] || ''));
  sheet.getRange('A43').setValue("ProjCode: " + (data['Project Code'] || ''));

  // --- C. FINANCIAL GRID (EWT - Row 39) ---
  
  // Determine Quarter Column (1st, 2nd, or 3rd month)
  // FIX: Use JEV Date for column logic. Fallback to Period Start if missing.
  const dateForColumn = data['JEV Date'] || data['Period Start'];
  const qCol = getQuarterColumn(dateForColumn);

  const amountBase = parseFloat(data['Tax Base']) || 0;
  const amountEwt = parseFloat(data['EWT Amount']) || 0;

  sheet.getRange('A39').setValue("Management and Technical Consultants"); // Fixed Desc
  sheet.getRange('L39').setValue(data['ATC Code']); // WI050 or WI051
  
  if (amountBase > 0) {
    // Set Base in specific quarter month column
    sheet.getRange(qCol + '39').setValue(amountBase); 
    // Set Total Base (AD39)
    sheet.getRange('AD39').setValue(amountBase);
    // Set Withheld (AI39)
    sheet.getRange('AI39').setValue(amountEwt);
    // Set Footer Total (AI48)
    sheet.getRange('AI48').setValue(amountEwt);
  }

  // --- D. FINANCIAL GRID (GMP - Row 52) ---
  const amountVat = parseFloat(data['VAT Amount']) || 0;
  const amountPtax = parseFloat(data['PTax Amount']) || 0;
  
  let gmpDesc = '';
  let gmpAtc = '';
  let gmpTax = 0;

  if (amountVat > 0) {
    gmpDesc = "VAT Withholding on Purchases of Services (with waiver of privilege to claim input tax credit) (creditable)";
    gmpAtc = "WV022";
    gmpTax = amountVat;
  } else if (amountPtax > 0) {
    gmpDesc = "Persons Exempt from VAT under Sec 109BB (creditable) - Government Withholding Agent";
    gmpAtc = "WB080";
    gmpTax = amountPtax;
  }

  if (gmpTax > 0) {
    sheet.getRange('A52').setValue(gmpDesc);
    sheet.getRange('L52').setValue(gmpAtc);
    
    // Map Base and Tax
    sheet.getRange(qCol + '52').setValue(amountBase); // Base is usually same as EWT Base
    sheet.getRange('AD52').setValue(amountBase);
    sheet.getRange('AI52').setValue(gmpTax);
    // Footer Total (AI61)
    sheet.getRange('AI61').setValue(gmpTax);
  }

  // --- E. SIGNATURE (If Final) ---
  if (isFinal) {
    insertSignature(sheet);
  }
}

// --- HELPER: DATA ACCESS ---

function getTaxDataByDv(dvNo) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Tax_Cert_Data');
  if (!sheet || sheet.getLastRow() < 2) return null;
  const data = sheet.getDataRange().getValues();
  
  for (let i = 1; i < data.length; i++) {
    if (data[i][0].toString().trim() === dvNo.toString().trim()) {
      return {
        'DV No': data[i][0],
        'Payee Name': data[i][1],
        'Address': data[i][2],
        'TIN': data[i][3],
        'Tax Base': data[i][4],
        'EWT Amount': data[i][5],
        'VAT Amount': data[i][6],
        'PTax Amount': data[i][7],
        'ATC Code': data[i][8],
        'Period Start': data[i][9],
        'Period End': data[i][10],
        'Status': data[i][11],
        'PDF Link': data[i][12],
        'Tax Cert Link': data[i][13],
        'JEV Date': data[i][14], // NEW: Column O
        'rowIndex': i + 1
      };
    }
  }
  return null;
}

function getTaxCertList() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Tax_Cert_Data');
  if (!sheet || sheet.getLastRow() < 2) return [];
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  return data.map(row => ({
    'DV No': row[0],
    'Payee Name': row[1],
    'Tax Base': row[4],
    'EWT Amount': row[5],
    'Status': row[11],
    'Tax Cert Link': row[13]
  })).reverse(); 
}

function updateTaxCertLink(dvNo, url, status) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Tax_Cert_Data');
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0].toString() === dvNo.toString()) {
      sheet.getRange(i + 1, 14).setValue(url); // Col N (Index 13 + 1)
      sheet.getRange(i + 1, 12).setValue(status); // Col L (Index 11 + 1)
      break;
    }
  }
}

// --- HELPER: FORMATTING ---

function splitDateToCells(sheet, dateStr, cM, cD, cY) {
  if (!dateStr) return;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return;
  sheet.getRange(cM).setValue(String(d.getMonth() + 1).padStart(2, '0'));
  sheet.getRange(cD).setValue(String(d.getDate()).padStart(2, '0'));
  sheet.getRange(cY).setValue(String(d.getFullYear()));
}

function splitTinToCells(sheet, tinStr, c1, c2, c3, c4) {
  if (!tinStr) return;
  const clean = tinStr.replace(/[^0-9-]/g, ''); 
  const parts = clean.split('-');
  if (parts[0]) sheet.getRange(c1).setValue(parts[0]);
  if (parts[1]) sheet.getRange(c2).setValue(parts[1]);
  if (parts[2]) sheet.getRange(c3).setValue(parts[2]);
  if (parts[3]) sheet.getRange(c4).setValue(parts[3]);
}

function getQuarterColumn(dateStr) {
  if (!dateStr) return 'O'; 
  const d = new Date(dateStr);
  return (d.getMonth() % 3 === 0) ? 'O' : (d.getMonth() % 3 === 1) ? 'T' : 'Y';
}

function insertSignature(sheet) {
  try {
    const imageBlob = DriveApp.getFileById(SIGNATURE_FILE_ID).getBlob();
    
    // Anchor: Row 62 (The "Declaration" text row)
    const signature = sheet.insertImage(imageBlob, 1, 62); 
    
    signature.setHeight(60); 
    signature.setWidth(150); 
    
    // X: Center
    signature.setAnchorCellXOffset(300); 
    
    // Y: Push DOWN 35 pixels. 
    // This clears the text in Row 62 and lands in the empty space of Row 63.
    signature.setAnchorCellYOffset(53); 
    
  } catch (e) { console.error("Sig Error: " + e.message); }
}

// --- EMAIL & APPROVAL ---

function sendAccountantEmail(dvNo) {
  try {
    const taxData = getTaxDataByDv(dvNo);
    const masterData = getMasterDvData(dvNo);
    if (!taxData || !masterData) throw new Error("Data not found for DV " + dvNo);

    const draftId = getIdFromUrl(taxData['Tax Cert Link']);
    const dvId = getIdFromUrl(masterData['PDF_Link']);
    
    const draftBlob = DriveApp.getFileById(draftId).getBlob();
    const dvBlob = DriveApp.getFileById(dvId).getBlob();

    const scriptUrl = ScriptApp.getService().getUrl();
    const approveLink = `${scriptUrl}?action=approve&dv=${dvNo}`;
    const rejectLink = `${scriptUrl}?action=reject&dv=${dvNo}`;

    // Format amount for professional look
    let formattedAmount = masterData['Amount Due'];
    if (typeof formattedAmount === 'number') {
        formattedAmount = formattedAmount.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
    }

    const htmlBody = `
      <div style="font-family: Arial, sans-serif; font-size: 16px; color: #333; max-width: 600px; margin: auto; border: 1px solid #ddd;">
        <div style="background-color: #1C2790; padding: 20px; text-align: center;">
            <img src="https://i.imgur.com/jaEbfAR.png" alt="DAP Logo" style="width: 400px;">
        </div>
        <div style="padding: 25px; border-top: 5px solid #CDAE2C;">
            <h2 style="color: #1C2790; text-align: center; font-size: 24px; text-transform: uppercase;">TAX CERTIFICATE APPROVAL REQUEST</h2>
            <p>Dear <b>Accountant</b>,</p>
            <p>A Tax Certificate (BIR Form 2307) draft has been generated and requires your review and approval. Please find the transaction details below.</p>
            
            <table style="width: 100%; border-collapse: collapse; margin-top: 25px; margin-bottom: 25px;">
                <tr style="background-color: #f2f2f2;"><td style="padding: 12px; border: 1px solid #ddd; font-weight: bold;">Payee Name:</td><td style="padding: 12px; border: 1px solid #ddd;">${taxData['Payee Name']}</td></tr>
                <tr><td style="padding: 12px; border: 1px solid #ddd; font-weight: bold;">Amount:</td><td style="padding: 12px; border: 1px solid #ddd; font-weight: bold; font-size: 1.1em; color: #1C2790;">PHP ${formattedAmount}</td></tr>
                <tr><td style="padding: 12px; border: 1px solid #ddd; font-weight: bold;">DV Number:</td><td style="padding: 12px; border: 1px solid #ddd;">${dvNo}</td></tr>
            </table>

            <p>Attached are the <b>Original Disbursement Voucher</b> and the <b>Draft Tax Certificate</b> for your reference.</p>
            <p style="font-weight: bold;">Please select an action below to proceed:</p>

            <div style="text-align: center; margin: 30px 0;">
                <a href="${approveLink}" style="background-color: #28a745; color: white; padding: 15px 25px; text-decoration: none; border-radius: 5px; font-weight: bold; margin-right: 10px; display: inline-block;">✅ APPROVE & SIGN</a>
                <a href="${rejectLink}" style="background-color: #dc3545; color: white; padding: 15px 25px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block;">❌ REJECT</a>
            </div>

            <p style="margin-top: 30px;">Thank you,</p>
            <p><b>Finance Department</b></p>
        </div>
        <div style="text-align: center; font-size: 12px; color: #777; padding: 15px; background-color: #f9f9f9; border-top: 1px solid #ddd;">
            <p>This is an automated notification from the DAP E-Payment System.</p>
        </div>
      </div>
    `;

    MailApp.sendEmail({
      to: ACCOUNTANT_EMAIL,
      bcc: 'anchetad@dap.edu.ph,singcaj@dap.edu.ph', // Added BCC
      subject: `APPROVAL REQUIRED: Tax Cert for ${taxData['Payee Name']} (DV ${dvNo})`,
      htmlBody: htmlBody,
      name: 'DAP E-Payment System',
      attachments: [dvBlob, draftBlob]
    });

    return { success: true };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

function handleTaxCertAction(action, dvNo) {
  if (action === 'approve') {
    // 1. Generate Final Signed PDF
    generateTaxCert(dvNo, true); 
    
    // 2. Run Traffic Controller (Send to Payee or Queue)
    const result = handleTaxCertDelivery(dvNo);

    // 3. NEW: Send Confirmation Copy to Accountant
    sendAccountantConfirmation(dvNo);

    return HtmlService.createHtmlOutput(`<h1 style="color:green;text-align:center;">Approved & Signed</h1><p style="text-align:center;">The Tax Certificate has been successfully signed.<br>${result}</p>`);
  } 
  else if (action === 'reject') {
    updateTaxCertLink(dvNo, '', 'Rejected');
    return HtmlService.createHtmlOutput(`<h1 style="color:red;text-align:center;">Rejected</h1><p style="text-align:center;">The Tax Certificate draft has been discarded.</p>`);
  }
}

function handleTaxCertDelivery(dvNo) {
  const masterSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Master_DV_List');
  const data = masterSheet.getDataRange().getValues();
  const headers = data[0];
  const dvIdx = headers.indexOf('DV No');
  const payTimeIdx = headers.indexOf('Payment Timestamp');
  const taxLinkIdx = headers.indexOf('Tax Cert Link');
  const nameIdx = headers.indexOf('Payee Name');
  
  let rowIdx = -1, paymentSent = false, payeeName = '';

  for (let i = 1; i < data.length; i++) {
    if (data[i][dvIdx].toString() === dvNo.toString()) {
      rowIdx = i + 1;
      paymentSent = !!data[i][payTimeIdx];
      payeeName = data[i][nameIdx];
      break;
    }
  }

  if (rowIdx === -1) return "Error: DV not found.";
  const taxData = getTaxDataByDv(dvNo);
  const pdfUrl = taxData['Tax Cert Link'];

  if (taxLinkIdx > -1) masterSheet.getRange(rowIdx, taxLinkIdx + 1).setValue(pdfUrl);

  if (paymentSent) {
    const payeeDb = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Payee_Database').getDataRange().getValues();
    const payeeRow = payeeDb.find(r => r[0] === payeeName);
    const email = payeeRow ? payeeRow[2] : ''; 

    if (email) {
      const fileBlob = DriveApp.getFileById(getIdFromUrl(pdfUrl)).getBlob();
      MailApp.sendEmail({
        to: email,
        subject: `Additional Attachment: Tax Certificate (DV ${dvNo})`,
        htmlBody: `<p>Dear ${payeeName},</p><p>Please find attached your BIR Form 2307 for DV No. ${dvNo}.</p>`,
        attachments: [fileBlob]
      });
      return "Fund transfer already sent. Separate email sent to Payee.";
    }
    return "Fund transfer sent, but Payee Email not found.";
  }
  return "Fund transfer pending. Tax Cert queued for bundling.";
}

function getMasterDvData(dvNo) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Master_DV_List');
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const dvIdx = headers.indexOf('DV No');
  
  for(let i=1; i<data.length; i++) {
    if(data[i][dvIdx].toString() === dvNo.toString()) {
      return {
        'PDF_Link': data[i][headers.indexOf('PDF_Link')],
        'Amount Due': data[i][headers.indexOf('Amount Due')],
        'JEV No': data[i][headers.indexOf('JEV No')],       // NEW
        'Project Code': data[i][headers.indexOf('Project Code')] // NEW
      };
    }
  }
  return null;
}

function getIdFromUrl(url) {
  const match = url.match(/id=([^&]+)/) || url.match(/\/d\/(.+?)\//);
  return match ? match[1] : null;
}

function authorizeNewPermissions() {
  UrlFetchApp.fetch("https://www.google.com");
}
/**
 * Sends a confirmation email to the Accountant with the final signed PDF.
 */
function sendAccountantConfirmation(dvNo) {
  try {
    const taxData = getTaxDataByDv(dvNo);
    if (!taxData || !taxData['Tax Cert Link']) return; // Safety check

    const signedPdfId = getIdFromUrl(taxData['Tax Cert Link']);
    const signedBlob = DriveApp.getFileById(signedPdfId).getBlob();

    const htmlBody = `
      <div style="font-family: Arial, sans-serif; font-size: 16px; color: #333; max-width: 600px; margin: auto; border: 1px solid #ddd;">
        <div style="background-color: #1C2790; padding: 20px; text-align: center;">
            <img src="https://i.imgur.com/jaEbfAR.png" alt="DAP Logo" style="width: 400px;">
        </div>
        <div style="padding: 25px; border-top: 5px solid #28a745;">
            <h2 style="color: #1C2790; text-align: center; font-size: 24px; text-transform: uppercase;">ACTION CONFIRMED</h2>
            <p>Dear <b>Accountant</b>,</p>
            <p>You have successfully <b>APPROVED</b> and <b>SIGNED</b> the Tax Certificate for:</p>
            
            <div style="background: #f8f9fa; padding: 15px; border-radius: 5px; margin: 20px 0;">
                <p style="margin: 5px 0;"><b>Payee:</b> ${taxData['Payee Name']}</p>
                <p style="margin: 5px 0;"><b>DV No:</b> ${dvNo}</p>
            </div>

            <p>A copy of the signed BIR Form 2307 is attached to this email for your personal records.</p>

            <p style="margin-top: 30px;">Thank you,</p>
            <p><b>Finance Department</b></p>
        </div>
        <div style="text-align: center; font-size: 12px; color: #777; padding: 15px; background-color: #f9f9f9; border-top: 1px solid #ddd;">
            <p>This is an automated notification from the DAP E-Payment System.</p>
        </div>
      </div>
    `;

    MailApp.sendEmail({
      to: ACCOUNTANT_EMAIL,
      bcc: 'anchetad@dap.edu.ph,singcaj@dap.edu.ph', // Added BCC
      subject: `SIGNED COPY: Tax Cert for ${taxData['Payee Name']} (DV ${dvNo})`,
      htmlBody: htmlBody,
      name: 'DAP E-Payment System',
      attachments: [signedBlob]
    });

  } catch (e) {
    console.error("Failed to send accountant confirmation: " + e.message);
  }
}