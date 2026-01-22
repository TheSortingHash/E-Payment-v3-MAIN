DAP E-Payment System (v3)

Automated Financial Middleware for Landbank WeAccess Interoperability

📖 Overview

The DAP E-Payment System is a serverless web application built on Google Workspace (Apps Script) that bridges the gap between the Development Academy of the Philippines (DAP) internal financial records and the Landbank WeAccess Institutional Banking portal.

It solves the critical problem of manual encoding by automating the ingestion, validation, and file generation processes required for bulk electronic disbursements. It serves as a secure "Traffic Controller," routing tasks between Accounting, Treasury, and Admin roles.

🚀 Key Features

Intelligent Ingestion: OCR-based scanning of Disbursement Vouchers (PDF) to extract Payee, Amount, and Tax data automatically.

Bank Interoperability: Generates strict-format CSV files (FINDES) compatible with Landbank WeAccess.

Anti-Fraud Validation: Automated auditing that compares the Bank's Payroll Register PDF line-by-line against internal records before payment approval.

Tax Automation: Auto-generates, routes for approval, and digitally signs BIR Form 2307 (Certificate of Creditable Tax Withheld).

Smart Fund Routing: Distinguishes between personal payroll accounts and custodial (Petty Cash/SDO) accounts automatically.

Role-Based Access Control: Secure, session-based login for Accounting, Treasury, and System Administrators.

🛠️ Tech Stack

Backend: Google Apps Script (Server-side JavaScript)

Frontend: HTML5, CSS3, Client-side JS (Served via HtmlService)

Database: Google Sheets (Relational tables for Ledger, Payees, Users)

Storage: Google Drive API (For PDF DVs, Bank Files, and Archives)

OCR Engine: Google Drive API (Docs conversion method)

📂 System Architecture

The system operates on a 6-Stage Lifecycle:

Ingestion (Accounting): Upload & Validate DV -> Master_DV_List

Tax Compliance: Generate Draft 2307 -> Accountant Approval -> Signed PDF

Batching (Treasury): Group DVs -> Assign Batch ID

Bridging: Generate FINDES -> Upload to Bank -> Validate Bank Register -> Endorse

Finalization: Bank Approval -> Generate Annex H -> Notify Payees

Recording: Bundle Files -> Email to Accounting for JEV

📜 Installation & Setup

Note: This system is designed for the Google Workspace environment.

Clone the Project:

Create a new Google Apps Script project.

Copy the .js and .html files from this repository into the script editor.

Setup Google Sheets (Database):

Create a spreadsheet with the following sheets: Master_DV_List, Payee_Database, User_Database, SDO_PCF_Accounts, Tax_Cert_Data, Config.

Refer to System Documentation.md for column schemas.

Setup Google Drive Folders:

Create root folders for Incoming, Processed, and Archive.

Add their Folder IDs to the Config sheet.

Enable Advanced Services:

In the Apps Script Editor > Project Settings > General Settings:

Enable Drive API (v2 or v3).

Enable Google Sheets API.

Deploy as Web App:

Click Deploy > New Deployment.

Select type: Web App.

Execute as: Me (Owner).

Who has access: Anyone within [Your Organization].

🛡️ Security

Session Management: Uses CacheService for token-based authentication (8-hour expiry).

Password Hashing: SHA-256 implementation for user credentials.

Concurrency Control: LockService prevents race conditions during database writes.

📄 License

This project is proprietary software developed for the Development Academy of the Philippines. Unauthorized distribution or use is prohibited.

Maintained by: Finance Department, DAP
