param(
    [ValidateSet(
        "all",
        "player-only",
        "player-scholarship",
        "player-volunteer",
        "player-coach",
        "player-scholarship-volunteer",
        "player-scholarship-coach",
        "player-scholarship-volunteer-coach",
        "standalone-volunteer",
        "standalone-coach"
    )]
    [string]$Route = "all",

    [string]$Email = "hligon@getsparqd.com",

    [string]$BaseUrl = "https://mlsregistration-preview.bhall-554.workers.dev"
)

$ErrorActionPreference = "Stop"

function New-TestId([string]$prefix) {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmssfff"
    return "TEST-$prefix-$stamp-$([Guid]::NewGuid().ToString('N').Substring(0,8))"
}

function Invoke-PreviewJson {
    param(
        [Parameter(Mandatory=$true)][string]$Path,
        [Parameter(Mandatory=$true)][hashtable]$Body
    )

    $uri = "$BaseUrl$Path"
    $json = $Body | ConvertTo-Json -Depth 20

    try {
        $result = Invoke-RestMethod `
            -Uri $uri `
            -Method POST `
            -Headers @{ Origin = $BaseUrl } `
            -ContentType "application/json" `
            -Body $json

        if ($null -eq $result -or $result.ok -ne $true) {
            $msg = if ($result.error) { $result.error } else { "Request returned ok != true" }
            throw "$Path failed: $msg"
        }

        return $result
    }
    catch {
        Write-Host ""
        Write-Host "[FAIL] $Path" -ForegroundColor Red
        Write-Host $_.Exception.Message -ForegroundColor Red
        throw
    }
}

function New-RegistrationValues {
    param(
        [string]$SubmissionId,
        [string]$EmailAddress,
        [bool]$Scholarship,
        [string]$HelpChoice,
        [string]$RouteName
    )

    $now = (Get-Date).ToUniversalTime().ToString("o")

    return @{
        defer_confirmation_email = "yes"
        registration_submission_id = $SubmissionId
        submitted_at = $now
        page_url = "$BaseUrl/?testRoute=$RouteName"
        parent_first_name = "TEST"
        parent_last_name = "PARENT"
        parent_email = $EmailAddress
        parent_phone = "2705550100"
        parent_guardian_dob = "01/01/1985"
        parent_street = "100 Test Street"
        parent_apt = ""
        parent_city = "Paducah"
        parent_state = "KY"
        parent_zip = "42001"

        emergency_same_as_parent = "yes"
        emergency_first_name = ""
        emergency_last_name = ""
        emergency_relationship = ""
        emergency_email = ""
        emergency_phone = ""
        emergency_street = ""
        emergency_apt = ""
        emergency_city = ""
        emergency_state = ""
        emergency_zip = ""

        player_count = "1"
        player_1_first_name = "TEST"
        player_1_last_name = "CHILD"
        player_1_dob = "01/01/2017"
        player_1_gender = "Male"
        player_1_grade = "2nd/3rd Grade Boys"
        player_1_jersey = "YM"
        player_1_shorts = "YM"
        player_1_socks = "YS/YM"
        player_1_race = "I do not wish to disclose"
        player_1_race_other = ""
        player_1_favorite_club = "Do not have a favorite MLS team"
        player_1_hear_about = "Local Operator Email"
        player_1_add_another = "No"

        scholarship_requested = $(if ($Scholarship) { "Yes" } else { "No" })
        help_choice = $HelpChoice
        agree_waiver = "yes"
        agree_privacy = "yes"
        agree_marketing = "yes"
        signature = ""
    }
}

function New-PlayerAgreementPayload {
    param(
        [string]$SubmissionId,
        [string]$EmailAddress
    )

    $acceptedAt = (Get-Date).ToUniversalTime().ToString("o")

    return @{
        agreementType = "player"
        formType = "mls_registration"
        submissionId = $SubmissionId
        signer = @{
            printedName = "TEST PARENT"
        }
        signature = @{
            method = "checkbox-consent"
        }
        audit = @{
            viewedAtUtc = $acceptedAt
            signedAtUtc = $acceptedAt
            consentAccepted = $true
            consentVersion = "v1-2026-08-06"
        }
        fields = @{
            registrationSubmissionId = $SubmissionId
            printedFullName = "TEST PARENT"
            relationshipToChild = "Parent/Legal Guardian"
            participantNames = "TEST CHILD"
            primaryPhone = "2705550100"
            parentStreet = "100 Test Street"
            parentCity = "Paducah"
            parentState = "KY"
            parentZip = "42001"
            parentEmail = $EmailAddress
            parentPhone = "2705550100"
            guardianName = "TEST PARENT"
            guardianDob = "01/01/1985"
            guardianStreet = "100 Test Street"
            guardianCity = "Paducah"
            guardianState = "KY"
            guardianZip = "42001"
            guardianPhone = "2705550100"
            guardianEmail = $EmailAddress
            emergencyContactName = "TEST PARENT"
            emergencyRelationship = "Same as parent/guardian"
            emergencyEmail = $EmailAddress
            emergencyPhone = "2705550100"
            emergencyStreet = "100 Test Street"
            emergencyCity = "Paducah"
            emergencyState = "KY"
            emergencyZip = "42001"
            signingDate = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd")
        }
    }
}

function New-VolunteerValues {
    param(
        [string]$SubmissionId,
        [string]$EmailAddress,
        [string]$LinkedParentEmail
    )

    return @{
        submittedAt = (Get-Date).ToUniversalTime().ToString("o")
        form_type = "volunteer_application"
        submission_id = $SubmissionId
        pageUrl = "$BaseUrl/?flow=volunteer&test=1"
        firstName = "TEST"
        lastName = "VOLUNTEER"
        email = $EmailAddress
        phone = "2705550101"
        street = "101 Test Street"
        apt = ""
        city = "Paducah"
        state = "KY"
        zip = "42001"
        dob = "01/01/1985"
        roles = @("Game-day operations")
        hasExperience = "No"
        experienceSummary = ""
        availabilityNotes = "Saturday mornings"
        agreement = $true
        signature = ""
        linkedParentEmail = $LinkedParentEmail
    }
}

function New-CoachValues {
    param(
        [string]$SubmissionId,
        [string]$EmailAddress,
        [string]$LinkedParentEmail
    )

    $data = New-VolunteerValues -SubmissionId $SubmissionId -EmailAddress $EmailAddress -LinkedParentEmail $LinkedParentEmail
    $data.form_type = "coaching_application"
    $data.pageUrl = "$BaseUrl/?flow=coach&test=1"
    $data.firstName = "TEST"
    $data.lastName = "COACH"
    $data.coachHasExperience = "Yes"
    $data.coachExperienceSummary = "Automated preview route test"
    $data.coachAvailability = @("Saturday mornings")
    $data.ref1Name = "TEST REFERENCE"
    $data.ref1Relationship = "Colleague"
    $data.ref1Phone = "2705550102"
    $data.ref1Email = $EmailAddress
    $data.coachCertifications = @("None currently")
    $data.coachBackgroundConsent = $true
    $data.coachSignature = ""
    return $data
}

function New-VolunteerAgreementPayload {
    param(
        [string]$FormType,
        [string]$SubmissionId,
        [string]$SignerName
    )

    $acceptedAt = (Get-Date).ToUniversalTime().ToString("o")

    return @{
        agreementType = "volunteer"
        formType = $FormType
        submissionId = $SubmissionId
        signer = @{
            printedName = $SignerName
            ageYears = 41
        }
        signature = @{
            method = "checkbox-consent"
        }
        audit = @{
            viewedAtUtc = $acceptedAt
            signedAtUtc = $acceptedAt
            consentAccepted = $true
            consentVersion = "v1-2026-08-06"
        }
        fields = @{
            legalName = $SignerName
            signingDate = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd")
        }
    }
}

function Get-RouteConfig([string]$Name) {
    switch ($Name) {
        "player-only" {
            return @{
                Player=$true; Scholarship=$false; Volunteer=$false; Coach=$false
                EmailType="registration_player"
                Forms=@("Player Registration")
                Agreements=@("Player Agreement","PPF Liability")
                HelpChoice="No, finish my registration"
            }
        }
        "player-scholarship" {
            return @{
                Player=$true; Scholarship=$true; Volunteer=$false; Coach=$false
                EmailType="scholarship_player"
                Forms=@("Player Registration","Scholarship Application")
                Agreements=@("Player Agreement","PPF Liability","Scholarship Guidelines")
                HelpChoice="No, finish my registration"
            }
        }
        "player-volunteer" {
            return @{
                Player=$true; Scholarship=$false; Volunteer=$true; Coach=$false
                EmailType="registration_player_volunteer"
                Forms=@("Player Registration","Volunteer Application")
                Agreements=@("Player Agreement","PPF Liability","Volunteer Agreement")
                HelpChoice="Volunteer"
            }
        }
        "player-coach" {
            return @{
                Player=$true; Scholarship=$false; Volunteer=$false; Coach=$true
                EmailType="registration_player_coach"
                Forms=@("Player Registration","Coaching Application")
                Agreements=@("Player Agreement","PPF Liability","Volunteer Agreement")
                HelpChoice="Apply to coach"
            }
        }
        "player-scholarship-volunteer" {
            return @{
                Player=$true; Scholarship=$true; Volunteer=$true; Coach=$false
                EmailType="scholarship_player_volunteer"
                Forms=@("Player Registration","Scholarship Application","Volunteer Application")
                Agreements=@("Player Agreement","PPF Liability","Scholarship Guidelines","Volunteer Agreement")
                HelpChoice="Volunteer"
            }
        }
        "player-scholarship-coach" {
            return @{
                Player=$true; Scholarship=$true; Volunteer=$false; Coach=$true
                EmailType="scholarship_player_coach"
                Forms=@("Player Registration","Scholarship Application","Coaching Application")
                Agreements=@("Player Agreement","PPF Liability","Scholarship Guidelines","Volunteer Agreement")
                HelpChoice="Apply to coach"
            }
        }
        "player-scholarship-volunteer-coach" {
            return @{
                Player=$true; Scholarship=$true; Volunteer=$true; Coach=$true
                EmailType="scholarship_player_volunteer_coach"
                Forms=@("Player Registration","Scholarship Application","Volunteer Application","Coaching Application")
                Agreements=@("Player Agreement","PPF Liability","Scholarship Guidelines","Volunteer Agreement")
                HelpChoice="Volunteer and apply to coach"
            }
        }
        "standalone-volunteer" {
            return @{
                Player=$false; Scholarship=$false; Volunteer=$true; Coach=$false
                EmailType="standalone_volunteer"
                Forms=@("Volunteer Application")
                Agreements=@("Volunteer Agreement")
                HelpChoice=""
            }
        }
        "standalone-coach" {
            return @{
                Player=$false; Scholarship=$false; Volunteer=$false; Coach=$true
                EmailType="standalone_coach"
                Forms=@("Coaching Application")
                Agreements=@("Volunteer Agreement")
                HelpChoice=""
            }
        }
    }
}

function Run-Route([string]$Name) {
    $cfg = Get-RouteConfig $Name

    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host "TEST ROUTE: $Name" -ForegroundColor Cyan
    Write-Host "============================================================" -ForegroundColor Cyan

    $registrationId = if ($cfg.Player) { New-TestId "REG" } else { "" }
    $volunteerId = if ($cfg.Volunteer) { New-TestId "VOL" } else { "" }
    $coachId = if ($cfg.Coach) { New-TestId "COACH" } else { "" }

    $documentLinks = @()
    $participantNames = @()
    $primarySubmissionId = ""

    if ($cfg.Player) {
        $primarySubmissionId = $registrationId
        $participantNames = @("TEST CHILD")

        $registrationValues = New-RegistrationValues `
            -SubmissionId $registrationId `
            -EmailAddress $Email `
            -Scholarship $cfg.Scholarship `
            -HelpChoice $cfg.HelpChoice `
            -RouteName $Name

        $upsert = Invoke-PreviewJson -Path "/api/forms/upsert" -Body @{
            formType = "mls_registration"
            values = $registrationValues
        }
        Write-Host "[PASS] Player registration: $registrationId" -ForegroundColor Green

        $playerAgreement = Invoke-PreviewJson -Path "/api/sign-agreement" -Body (New-PlayerAgreementPayload -SubmissionId $registrationId -EmailAddress $Email)
        Write-Host "[PASS] Player Agreement generated" -ForegroundColor Green

        $playerAgreementUrl = [string]$playerAgreement.emailDownloadUrl
        if ([string]::IsNullOrWhiteSpace($playerAgreementUrl)) {
            $playerAgreementUrl = [string]$playerAgreement.signerDownloadUrl
        }
        if (-not [string]::IsNullOrWhiteSpace($playerAgreementUrl)) {
            $documentLinks += @{
                label = "Player Agreement - $Name"
                url = $playerAgreementUrl
            }
        }

        Write-Host "[INFO] Player Agreement callback also triggers the PPF archive workflow." -ForegroundColor Yellow
    }

    if ($cfg.Scholarship) {
        $scholarshipValues = @{
            defer_confirmation_email = "yes"
            submitted_at = (Get-Date).ToUniversalTime().ToString("o")
            registration_submission_id = $registrationId
            page_url = "$BaseUrl/?testRoute=$Name"
            parent_first_name = "TEST"
            parent_last_name = "PARENT"
            parent_email = $Email
            parent_phone = "2705550100"
            scholarship_requested = "Yes"
            scholarship_level = ""
            scholarship_household_size = ""
            scholarship_household_income = ""
            scholarship_eligibility = ""
            scholarship_circumstances = "Automated preview route test"
            scholarship_contribution_amount = ""
            scholarship_participation_commitment = "yes"
            scholarship_parent_acknowledgement = "yes"
            scholarship_guidelines_accepted = "yes"
            participant_names = "TEST CHILD"
        }

        $scholarship = Invoke-PreviewJson -Path "/api/forms/upsert" -Body @{
            formType = "scholarship_application"
            values = $scholarshipValues
        }
        Write-Host "[PASS] Scholarship application recorded" -ForegroundColor Green
    }

    if ($cfg.Volunteer) {
        if (-not $primarySubmissionId) { $primarySubmissionId = $volunteerId }

        $volValues = New-VolunteerValues `
            -SubmissionId $volunteerId `
            -EmailAddress $Email `
            -LinkedParentEmail $(if ($cfg.Player) { $Email } else { "" })

        $volUpsert = Invoke-PreviewJson -Path "/api/forms/upsert" -Body @{
            formType = "volunteer_application"
            values = $volValues
        }
        Write-Host "[PASS] Volunteer application: $volunteerId" -ForegroundColor Green
    }

    if ($cfg.Coach) {
        if (-not $primarySubmissionId) { $primarySubmissionId = $coachId }

        $coachValues = New-CoachValues `
            -SubmissionId $coachId `
            -EmailAddress $Email `
            -LinkedParentEmail $(if ($cfg.Player) { $Email } else { "" })

        $coachUpsert = Invoke-PreviewJson -Path "/api/forms/upsert" -Body @{
            formType = "coaching_application"
            values = $coachValues
        }
        Write-Host "[PASS] Coaching application: $coachId" -ForegroundColor Green
    }

    if ($cfg.Volunteer) {
        $volAgreement = Invoke-PreviewJson -Path "/api/sign-agreement" -Body (
            New-VolunteerAgreementPayload `
                -FormType "volunteer_application" `
                -SubmissionId $volunteerId `
                -SignerName "TEST VOLUNTEER"
        )
        Write-Host "[PASS] Volunteer Agreement generated and archived" -ForegroundColor Green

        $volAgreementUrl = [string]$volAgreement.emailDownloadUrl
        if ([string]::IsNullOrWhiteSpace($volAgreementUrl)) {
            $volAgreementUrl = [string]$volAgreement.signerDownloadUrl
        }
        if (-not [string]::IsNullOrWhiteSpace($volAgreementUrl)) {
            $documentLinks += @{
                label = "Volunteer Agreement - $Name"
                url = $volAgreementUrl
            }
        }
    }

    if ($cfg.Coach) {
        $coachAgreement = Invoke-PreviewJson -Path "/api/sign-agreement" -Body (
            New-VolunteerAgreementPayload `
                -FormType "coaching_application" `
                -SubmissionId $coachId `
                -SignerName "TEST COACH"
        )
        Write-Host "[PASS] Coaching Volunteer Agreement generated and archived" -ForegroundColor Green

        $coachAgreementUrl = [string]$coachAgreement.emailDownloadUrl
        if ([string]::IsNullOrWhiteSpace($coachAgreementUrl)) {
            $coachAgreementUrl = [string]$coachAgreement.signerDownloadUrl
        }
        if (-not [string]::IsNullOrWhiteSpace($coachAgreementUrl)) {
            $documentLinks += @{
                label = "Coaching Volunteer Agreement - $Name"
                url = $coachAgreementUrl
            }
        }
    }

    # The preview Worker automatically generates the scholarship document
    # during this call when scholarshipRequested=Yes and appends its permanent
    # document URL to the confirmation email.
    $finalPayload = @{
        submissionId = $primarySubmissionId
        registrationSubmissionId = $registrationId
        volunteerSubmissionId = $volunteerId
        coachingSubmissionId = $coachId
        emailType = $cfg.EmailType
        applicantFirstName = "TEST"
        applicantLastName = $(if ($cfg.Player) { "PARENT" } elseif ($cfg.Volunteer) { "VOLUNTEER" } else { "COACH" })
        recipientEmail = $Email
        participantNames = $participantNames
        formsRecorded = $cfg.Forms
        agreementsRecorded = $cfg.Agreements
        scholarshipRequested = $(if ($cfg.Scholarship) { "Yes" } else { "No" })
        paymentRequired = $false
        paymentUrl = ""
        paymentAmount = $(if ($cfg.Player -and -not $cfg.Scholarship) { "75" } else { "" })
        signedDocumentUrls = $documentLinks
        sourceUrl = "$BaseUrl/?testRoute=$Name"
    }

    $final = Invoke-PreviewJson -Path "/api/forms/final-confirmation" -Body $finalPayload
    Write-Host "[PASS] Confirmation email requested for $Email" -ForegroundColor Green

    if ($cfg.Scholarship -and $final.result.scholarshipDocumentUrl) {
        Write-Host "[PASS] Scholarship Guidelines document generated" -ForegroundColor Green
        Write-Host "       $($final.result.scholarshipDocumentUrl)"
    }

    Write-Host ""
    Write-Host "Route complete: $Name" -ForegroundColor Green
    Write-Host "Primary ID: $primarySubmissionId"
    if ($registrationId) { Write-Host "Registration ID: $registrationId" }
    if ($volunteerId) { Write-Host "Volunteer ID: $volunteerId" }
    if ($coachId) { Write-Host "Coach ID: $coachId" }

    return [pscustomobject]@{
        Route = $Name
        RegistrationId = $registrationId
        VolunteerId = $volunteerId
        CoachId = $coachId
        Email = $Email
        ConfirmationSent = $true
        ScholarshipDocumentUrl = [string]$final.result.scholarshipDocumentUrl
    }
}

$routes = @(
    "player-only",
    "player-scholarship",
    "player-volunteer",
    "player-coach",
    "player-scholarship-volunteer",
    "player-scholarship-coach",
    "player-scholarship-volunteer-coach",
    "standalone-volunteer",
    "standalone-coach"
)

if ($Route -ne "all") {
    $routes = @($Route)
}

Write-Host ""
Write-Host "MLS GO PREVIEW ROUTE TESTER" -ForegroundColor Cyan
Write-Host "Preview: $BaseUrl"
Write-Host "Test email: $Email"
Write-Host ""
Write-Host "WARNING: These are real preview API calls and can create TEST rows, Drive documents, and emails." -ForegroundColor Yellow

$results = @()

foreach ($routeName in $routes) {
    try {
        $results += Run-Route $routeName
    }
    catch {
        $results += [pscustomobject]@{
            Route = $routeName
            RegistrationId = ""
            VolunteerId = ""
            CoachId = ""
            Email = $Email
            ConfirmationSent = $false
            ScholarshipDocumentUrl = ""
        }

        if ($Route -ne "all") {
            throw
        }
    }
}

Write-Host ""
Write-Host "====================== TEST SUMMARY ======================" -ForegroundColor Cyan
$results | Format-Table -AutoSize

Write-Host ""
Write-Host "IMPORTANT:" -ForegroundColor Yellow
Write-Host "The confirmation email receives every document URL that the current public preview API returns." -ForegroundColor Yellow
Write-Host "Player Agreement and Volunteer Agreement URLs are included directly." -ForegroundColor Yellow
Write-Host "Scholarship Guidelines are generated by the final-confirmation route and appended by the Worker." -ForegroundColor Yellow
Write-Host "The PPF Liability document is generated/archived by the Apps Script callback, but the current preview API does not return its permanent Drive URL to this command-line client." -ForegroundColor Yellow
Write-Host "Therefore the email can report PPF Liability as recorded, but cannot include its completed PPF link until that URL is exposed by the backend." -ForegroundColor Yellow
