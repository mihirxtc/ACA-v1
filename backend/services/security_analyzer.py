from datetime import datetime, timezone

SEVERITY_ORDER = {"HIGH": 0, "MEDIUM": 1, "LOW": 2}


def make_finding(
    finding_id: str,
    resource_id: str,
    resource_type: str,
    rule: str,
    severity: str,
    title: str,
    description: str,
    recommendation: str,
    metadata: dict,
) -> dict:
    """
    Create a security finding dict with the standard schema.

    All 7 rule functions call this helper to ensure every finding has
    exactly the same shape. The LLM summary and the React UI both depend
    on this structure being consistent.

    Parameters:
        finding_id     (str)  : Unique identifier, e.g. "SSH_PORT_OPEN-sg-001-0"
        resource_id    (str)  : AWS resource ID, e.g. "sg-0abc1234"
        resource_type  (str)  : One of: EC2_SECURITY_GROUP, S3_BUCKET,
                                IAM_USER, VPC
        rule           (str)  : Short rule name, e.g. "SSH_PORT_OPEN"
        severity       (str)  : One of: HIGH, MEDIUM, LOW
        title          (str)  : Short human-readable title
        description    (str)  : What the problem is
        recommendation (str)  : What the user should do to fix it
        metadata       (dict) : Any extra context (port numbers, usernames, etc.)

    Returns:
        dict: A finding with all 9 required fields.
    """
    return {
        "finding_id": finding_id,
        "resource_id": resource_id,
        "resource_type": resource_type,
        "rule": rule,
        "severity": severity,
        "title": title,
        "description": description,
        "recommendation": recommendation,
        "metadata": metadata,
    }


def check_ssh_port_open(security_groups_data: dict) -> list:
    """
    Check whether any security group allows SSH (port 22) from the internet.

    Uses the pre-processed 'open_to_internet' field from the scanner output.
    Each entry in that list is already confirmed to be open to 0.0.0.0/0
    or ::/0, so we only need to check the port number here.

    Parameters:
        security_groups_data (dict): The 'security_groups' section of scan_data,
                                     as returned by scan_security_groups().

    Returns:
        list: One finding per security group that has port 22 open.
              Returns an empty list if no issues are found or on any error.
    """
    findings = []

    try:
        if security_groups_data.get("status") != "ok":
            return []

        security_groups = security_groups_data.get("security_groups", [])

        for i, sg in enumerate(security_groups):
            sg_id = sg.get("id", "unknown")
            sg_name = sg.get("name", "unknown")

            for entry in sg.get("open_to_internet", []):
                if entry.get("port") == 22:
                    finding_id = f"SSH_PORT_OPEN-{sg_id}-{i}"

                    findings.append(
                        make_finding(
                            finding_id=finding_id,
                            resource_id=sg_id,
                            resource_type="EC2_SECURITY_GROUP",
                            rule="SSH_PORT_OPEN",
                            severity="HIGH",
                            title="SSH port exposed to the internet",
                            description=(
                                f"Security group {sg_name} allows SSH (port 22) access "
                                f"from any IP address (0.0.0.0/0). This exposes the "
                                f"server to brute-force and credential attacks."
                            ),
                            recommendation=(
                                "Restrict port 22 to specific trusted IP addresses "
                                "only. Remove the 0.0.0.0/0 rule immediately."
                            ),
                            metadata={"port": 22, "group_name": sg_name},
                        )
                    )
                    break

    except Exception:
        return []

    return findings


def check_rdp_port_open(security_groups_data: dict) -> list:
    """
    Check whether any security group allows RDP (port 3389) from the internet.

    Same approach as check_ssh_port_open — uses the pre-processed
    'open_to_internet' field and checks for port 3389.

    Parameters:
        security_groups_data (dict): The 'security_groups' section of scan_data,
                                     as returned by scan_security_groups().

    Returns:
        list: One finding per security group that has port 3389 open.
              Returns an empty list if no issues are found or on any error.
    """
    findings = []

    try:
        if security_groups_data.get("status") != "ok":
            return []

        security_groups = security_groups_data.get("security_groups", [])

        for i, sg in enumerate(security_groups):
            sg_id = sg.get("id", "unknown")
            sg_name = sg.get("name", "unknown")

            for entry in sg.get("open_to_internet", []):
                if entry.get("port") == 3389:
                    finding_id = f"RDP_PORT_OPEN-{sg_id}-{i}"

                    findings.append(
                        make_finding(
                            finding_id=finding_id,
                            resource_id=sg_id,
                            resource_type="EC2_SECURITY_GROUP",
                            rule="RDP_PORT_OPEN",
                            severity="HIGH",
                            title="RDP port exposed to the internet",
                            description=(
                                f"Security group {sg_name} allows RDP (port 3389) from "
                                f"any IP. This exposes Windows servers to attacks."
                            ),
                            recommendation=(
                                "Restrict port 3389 to specific trusted IP addresses. "
                                "Consider using AWS Systems Manager Session Manager "
                                "instead of RDP for remote access."
                            ),
                            metadata={"port": 3389, "group_name": sg_name},
                        )
                    )
                    break

    except Exception:
        return []

    return findings


def check_s3_bucket_public(s3_data: dict) -> list:
    """
    Check whether any S3 bucket is publicly accessible.

    The scanner already determined is_public for each bucket by inspecting
    the bucket's ACL for AllUsers grants. We simply act on that flag here.

    Parameters:
        s3_data (dict): The 's3' section of scan_data, as returned by scan_s3().

    Returns:
        list: One finding per public S3 bucket.
              Returns an empty list if no issues are found or on any error.
    """
    findings = []

    try:
        if s3_data.get("status") != "ok":
            return []

        buckets = s3_data.get("buckets", [])

        for i, bucket in enumerate(buckets):
            bucket_name = bucket.get("name", "unknown")

            if bucket.get("is_public") is True:
                finding_id = f"S3_BUCKET_PUBLIC-{bucket_name}-{i}"

                findings.append(
                    make_finding(
                        finding_id=finding_id,
                        resource_id=bucket_name,
                        resource_type="S3_BUCKET",
                        rule="S3_BUCKET_PUBLIC",
                        severity="HIGH",
                        title="S3 bucket is publicly accessible",
                        description=(
                            f"Bucket {bucket_name} is publicly accessible. Anyone on "
                            f"the internet can read its contents. This is a "
                            f"critical data exposure risk."
                        ),
                        recommendation=(
                            "Remove public ACL from the bucket immediately. "
                            "Enable S3 Block Public Access settings. Review "
                            "bucket contents for sensitive data."
                        ),
                        metadata={"bucket_name": bucket_name},
                    )
                )

    except Exception:
        return []

    return findings


def check_iam_user_no_mfa(iam_data: dict) -> list:
    """
    Check whether any IAM user has no MFA device enabled.

    A user without MFA is vulnerable to password-only compromise.
    The scanner already checked has_mfa via list_mfa_devices().

    Parameters:
        iam_data (dict): The 'iam' section of scan_data, as returned by scan_iam().

    Returns:
        list: One finding per IAM user without MFA.
              Returns an empty list if no issues are found or on any error.
    """
    findings = []

    try:
        if iam_data.get("status") != "ok":
            return []

        users = iam_data.get("users", [])

        for i, user in enumerate(users):
            username = user.get("username", "unknown")

            if user.get("has_mfa") is False:
                finding_id = f"IAM_USER_NO_MFA-{username}-{i}"

                findings.append(
                    make_finding(
                        finding_id=finding_id,
                        resource_id=username,
                        resource_type="IAM_USER",
                        rule="IAM_USER_NO_MFA",
                        severity="MEDIUM",
                        title="IAM user has no MFA enabled",
                        description=(
                            f"User {username} does not have multi-factor "
                            f"authentication enabled. A stolen password alone "
                            f"would grant full access to this account."
                        ),
                        recommendation=(
                            "Enable MFA for this user immediately. Use a "
                            "virtual MFA app or hardware security key."
                        ),
                        metadata={"username": username},
                    )
                )

    except Exception:
        return []

    return findings


def check_unrestricted_traffic(security_groups_data: dict) -> list:
    """
    Check whether any security group allows ALL traffic from the internet.

    In boto3, a rule that allows all protocols is represented as IpProtocol
    set to the string "-1" (not the integer -1). The scanner preserves this
    value in the 'protocol' field of each open_to_internet entry.

    Parameters:
        security_groups_data (dict): The 'security_groups' section of scan_data,
                                     as returned by scan_security_groups().

    Returns:
        list: One finding per security group with an all-traffic rule.
              Returns an empty list if no issues are found or on any error.
    """
    findings = []

    try:
        if security_groups_data.get("status") != "ok":
            return []

        security_groups = security_groups_data.get("security_groups", [])

        for i, sg in enumerate(security_groups):
            sg_id = sg.get("id", "unknown")
            sg_name = sg.get("name", "unknown")

            for entry in sg.get("open_to_internet", []):
                if entry.get("protocol") == "-1":
                    finding_id = f"UNRESTRICTED_ALL_TRAFFIC-{sg_id}-{i}"

                    findings.append(
                        make_finding(
                            finding_id=finding_id,
                            resource_id=sg_id,
                            resource_type="EC2_SECURITY_GROUP",
                            rule="UNRESTRICTED_ALL_TRAFFIC",
                            severity="HIGH",
                            title="All traffic allowed from the internet",
                            description=(
                                f"Security group {sg_name} allows ALL traffic from any "
                                f"IP address. This completely removes network "
                                f"protection for attached resources."
                            ),
                            recommendation=(
                                "Remove this rule immediately. Define specific "
                                "inbound rules for only the ports and protocols "
                                "your application actually needs."
                            ),
                            metadata={"group_name": sg_name, "protocol": "all"},
                        )
                    )
                    break

    except Exception:
        return []

    return findings


def check_iam_user_inactive(iam_data: dict) -> list:
    """
    Check whether any IAM user has been inactive for 90 or more days.

    Two cases trigger this finding:
      1. last_login == "Never"  — the user has never logged in at all
      2. last_login is a date string that parses to > 90 days ago

    The scanner stores last_login as a string (either "Never" or the result
    of str() on a datetime object, e.g. "2024-01-15 10:30:00+00:00").
    We parse this string carefully and skip users where parsing fails.

    Parameters:
        iam_data (dict): The 'iam' section of scan_data, as returned by scan_iam().

    Returns:
        list: One finding per inactive IAM user.
              Returns an empty list if no issues are found or on any error.
    """
    findings = []

    NINETY_DAYS_SECONDS = 90 * 24 * 60 * 60

    try:
        if iam_data.get("status") != "ok":
            return []

        users = iam_data.get("users", [])

        now_utc = datetime.now(timezone.utc)

        for i, user in enumerate(users):
            username = user.get("username", "unknown")
            last_login = user.get("last_login", "Never")

            is_inactive = False

            if last_login == "Never":
                is_inactive = True

            else:
                try:
                    last_login_dt = datetime.fromisoformat(str(last_login))

                    if last_login_dt.tzinfo is None:
                        last_login_dt = last_login_dt.replace(tzinfo=timezone.utc)

                    age_seconds = (now_utc - last_login_dt).total_seconds()

                    if age_seconds > NINETY_DAYS_SECONDS:
                        is_inactive = True

                except (ValueError, TypeError):
                    continue

            if is_inactive:
                finding_id = f"IAM_USER_INACTIVE-{username}-{i}"

                findings.append(
                    make_finding(
                        finding_id=finding_id,
                        resource_id=username,
                        resource_type="IAM_USER",
                        rule="IAM_USER_INACTIVE",
                        severity="LOW",
                        title="IAM user has been inactive for 90+ days",
                        description=(
                            f"User {username} has not logged in for over 90 "
                            f"days (last login: {last_login}). Inactive accounts "
                            f"are a security risk if credentials are compromised."
                        ),
                        recommendation=(
                            "Review whether this user still needs access. "
                            "If not, disable or delete the account. If yes, "
                            "ensure credentials are rotated."
                        ),
                        metadata={"username": username, "last_login": last_login},
                    )
                )

    except Exception:
        return []

    return findings


def check_default_vpc(vpc_data: dict) -> list:
    """
    Check whether the default VPC exists in this region.

    The default VPC is created automatically by AWS in every region.
    It has permissive default settings and is not recommended for
    production workloads. Its presence is flagged as a best-practice issue.

    Parameters:
        vpc_data (dict): The 'vpc' section of scan_data, as returned by scan_vpc().

    Returns:
        list: One finding per default VPC found.
              Returns an empty list if no issues are found or on any error.
    """
    findings = []

    try:
        if vpc_data.get("status") != "ok":
            return []

        vpcs = vpc_data.get("vpcs", [])

        for i, vpc in enumerate(vpcs):
            vpc_id = vpc.get("id", "unknown")
            cidr = vpc.get("cidr", "unknown")

            if vpc.get("is_default") is True:
                finding_id = f"DEFAULT_VPC_IN_USE-{vpc_id}-{i}"

                findings.append(
                    make_finding(
                        finding_id=finding_id,
                        resource_id=vpc_id,
                        resource_type="VPC",
                        rule="DEFAULT_VPC_IN_USE",
                        severity="LOW",
                        title="Default VPC is in use",
                        description=(
                            f"The default VPC ({vpc_id}) exists in this region. "
                            f"The default VPC has permissive settings and is not "
                            f"recommended for production workloads."
                        ),
                        recommendation=(
                            "Create a custom VPC with appropriate CIDR ranges, "
                            "subnet configuration, and security controls. "
                            "Migrate resources out of the default VPC."
                        ),
                        metadata={"vpc_id": vpc_id, "cidr": cidr},
                    )
                )

    except Exception:
        return []

    return findings


def run_security_analysis(scan_data: dict) -> list:
    """
    Run all 7 security rules against the provided scan data.

    This function extracts the relevant section of scan_data for each rule,
    calls each rule function, combines all findings into one list, and
    sorts them by severity so that HIGH findings appear first.

    Parameters:
        scan_data (dict): The full output of a /scan call, expected to contain
                          keys: 'security_groups', 's3', 'iam', 'vpc'.
                          Missing keys are handled safely — each rule function
                          receives an empty dict and returns an empty list.

    Returns:
        list: All findings from all 7 rules, sorted HIGH → MEDIUM → LOW.
              Returns an empty list if scan_data is empty or all rules pass.
    """

    security_groups_data = scan_data.get("security_groups", {})
    s3_data = scan_data.get("s3", {})
    iam_data = scan_data.get("iam", {})
    vpc_data = scan_data.get("vpc", {})

    all_findings = []

    all_findings.extend(check_ssh_port_open(security_groups_data))
    all_findings.extend(check_rdp_port_open(security_groups_data))
    all_findings.extend(check_s3_bucket_public(s3_data))
    all_findings.extend(check_iam_user_no_mfa(iam_data))
    all_findings.extend(check_unrestricted_traffic(security_groups_data))
    all_findings.extend(check_iam_user_inactive(iam_data))
    all_findings.extend(check_default_vpc(vpc_data))

    return sorted(all_findings, key=lambda f: SEVERITY_ORDER.get(f["severity"], 99))


