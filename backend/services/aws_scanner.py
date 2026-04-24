import boto3
from botocore.exceptions import ClientError, NoCredentialsError


def get_aws_session(credentials: dict) -> boto3.Session:
    """
    Build a boto3 Session from an explicit credentials dict.

    Using a per-request Session means each API call uses exactly the
    credentials the frontend supplied — there is no reliance on env vars,
    ~/.aws/credentials, or IAM instance roles bleeding across requests.

    The dict may use either "aws_region" (frontend convention) or
    "region" (internal agent_service convention); both are checked.
    """
    return boto3.Session(
        aws_access_key_id=credentials.get("aws_access_key_id"),
        aws_secret_access_key=credentials.get("aws_secret_access_key"),
        region_name=credentials.get(
            "aws_region", credentials.get("region", "us-east-1")
        ),
    )


def scan_ec2(region: str = "us-east-1", credentials: dict = None) -> dict:
    """
    Scan all EC2 instances in the given AWS region.

    Returns a dict with:
      - status: "ok" or "error"
      - count: number of instances found
      - instances: list of dicts, each with id, name, type, state,
                   public_ip, private_ip, launch_time, security_group_ids

    On any error, returns {"status": "error", "error": "...",
                           "count": 0, "instances": []}
    """

    try:
        ec2_client = (
            get_aws_session(credentials).client("ec2", region_name=region)
            if credentials
            else boto3.client("ec2", region_name=region)
        )

        response = ec2_client.describe_instances()

        instances = []

        for reservation in response.get("Reservations", []):
            for instance in reservation.get("Instances", []):
                name = ""
                for tag in instance.get("Tags", []):
                    if tag.get("Key") == "Name":
                        name = tag.get("Value", "")
                        break

                security_group_ids = []
                for sg in instance.get("SecurityGroups", []):
                    group_id = sg.get("GroupId")
                    if group_id:
                        security_group_ids.append(group_id)

                launch_time_raw = instance.get("LaunchTime")
                if launch_time_raw:
                    launch_time = str(launch_time_raw)
                else:
                    launch_time = "Unknown"

                instances.append(
                    {
                        "id": instance.get("InstanceId", ""),
                        "name": name,
                        "type": instance.get("InstanceType", ""),
                        "state": instance.get("State", {}).get("Name", ""),
                        "public_ip": instance.get("PublicIpAddress"),
                        "private_ip": instance.get("PrivateIpAddress"),
                        "launch_time": launch_time,
                        "security_group_ids": security_group_ids,
                    }
                )

        return {
            "status": "ok",
            "count": len(instances),
            "instances": instances,
        }

    except NoCredentialsError:
        return {
            "status": "error",
            "error": "AWS credentials not found. Run 'aws configure' to set them up.",
            "count": 0,
            "instances": [],
        }
    except ClientError as error:
        return {
            "status": "error",
            "error": f"AWS API error: {error.response.get('Error', {}).get('Message', str(error))}",
            "count": 0,
            "instances": [],
        }
    except Exception as error:
        return {
            "status": "error",
            "error": f"Unexpected error: {str(error)}",
            "count": 0,
            "instances": [],
        }


def scan_s3(credentials: dict = None) -> dict:
    """
    Scan all S3 buckets in the AWS account.

    Note: S3 is a global service — buckets are not tied to a region,
    so we do not accept a region parameter here.

    For each bucket, we attempt to check whether it is publicly accessible
    by inspecting its ACL (Access Control List) for any grant that allows
    the "AllUsers" group (i.e. the entire internet).

    Returns a dict with:
      - status: "ok" or "error"
      - count: number of buckets found
      - buckets: list of dicts, each with name, created, is_public

    On any error, returns {"status": "error", "error": "...",
                           "count": 0, "buckets": []}
    """

    ALL_USERS_URI = "http://acs.amazonaws.com/groups/global/AllUsers"

    try:
        s3_client = (
            get_aws_session(credentials).client("s3")
            if credentials
            else boto3.client("s3")
        )

        response = s3_client.list_buckets()

        buckets = []

        for bucket in response.get("Buckets", []):
            bucket_name = bucket.get("Name", "")

            created_raw = bucket.get("CreationDate")
            if created_raw:
                created = str(created_raw)
            else:
                created = "Unknown"

            is_public = False
            try:
                acl_response = s3_client.get_bucket_acl(Bucket=bucket_name)
                for grant in acl_response.get("Grants", []):
                    grantee = grant.get("Grantee", {})
                    if grantee.get("URI") == ALL_USERS_URI:
                        is_public = True
                        break
            except Exception:
                is_public = False

            buckets.append(
                {
                    "name": bucket_name,
                    "created": created,
                    "is_public": is_public,
                }
            )

        return {
            "status": "ok",
            "count": len(buckets),
            "buckets": buckets,
        }

    except NoCredentialsError:
        return {
            "status": "error",
            "error": "AWS credentials not found. Run 'aws configure' to set them up.",
            "count": 0,
            "buckets": [],
        }
    except ClientError as error:
        return {
            "status": "error",
            "error": f"AWS API error: {error.response.get('Error', {}).get('Message', str(error))}",
            "count": 0,
            "buckets": [],
        }
    except Exception as error:
        return {
            "status": "error",
            "error": f"Unexpected error: {str(error)}",
            "count": 0,
            "buckets": [],
        }


def scan_iam(credentials: dict = None) -> dict:
    """
    Scan all IAM users in the AWS account.

    IAM is a global service — it is not tied to any region.
    For each user we check:
      - Whether they have MFA enabled (via list_mfa_devices)
      - When they last logged into the AWS Console (PasswordLastUsed)

    Returns a dict with:
      - status: "ok" or "error"
      - user_count: number of IAM users found
      - users: list of dicts, each with username, user_id, created,
               has_mfa, last_login

    On any error, returns {"status": "error", "error": "...",
                           "user_count": 0, "users": []}
    """

    try:
        iam_client = (
            get_aws_session(credentials).client("iam")
            if credentials
            else boto3.client("iam")
        )

        response = iam_client.list_users()

        users = []

        for user in response.get("Users", []):
            username = user.get("UserName", "")

            has_mfa = False
            try:
                mfa_response = iam_client.list_mfa_devices(UserName=username)
                mfa_devices = mfa_response.get("MFADevices", [])
                has_mfa = len(mfa_devices) > 0
            except Exception:
                has_mfa = False

            last_login_raw = user.get("PasswordLastUsed", None)
            if last_login_raw:
                last_login = str(last_login_raw)
            else:
                last_login = "Never"

            created_raw = user.get("CreateDate")
            if created_raw:
                created = str(created_raw)
            else:
                created = "Unknown"

            users.append(
                {
                    "username": username,
                    "user_id": user.get("UserId", ""),
                    "created": created,
                    "has_mfa": has_mfa,
                    "last_login": last_login,
                }
            )

        return {
            "status": "ok",
            "user_count": len(users),
            "users": users,
        }

    except NoCredentialsError:
        return {
            "status": "error",
            "error": "AWS credentials not found. Run 'aws configure' to set them up.",
            "user_count": 0,
            "users": [],
        }
    except ClientError as error:
        return {
            "status": "error",
            "error": f"AWS API error: {error.response.get('Error', {}).get('Message', str(error))}",
            "user_count": 0,
            "users": [],
        }
    except Exception as error:
        return {
            "status": "error",
            "error": f"Unexpected error: {str(error)}",
            "user_count": 0,
            "users": [],
        }


def scan_security_groups(region: str = "us-east-1", credentials: dict = None) -> dict:
    """
    Scan all EC2 security groups in the given AWS region.

    For each security group we inspect its inbound rules and flag any
    rule that allows traffic from the entire internet (0.0.0.0/0 or ::/0).
    A group is marked is_dangerous=True if it has any such rule.

    Returns a dict with:
      - status: "ok" or "error"
      - count: number of security groups found
      - security_groups: list of dicts, each with id, name, description,
                         vpc_id, open_to_internet, is_dangerous

    On any error, returns {"status": "error", "error": "...",
                           "count": 0, "security_groups": []}
    """

    try:
        ec2_client = (
            get_aws_session(credentials).client("ec2", region_name=region)
            if credentials
            else boto3.client("ec2", region_name=region)
        )

        response = ec2_client.describe_security_groups()

        security_groups = []

        for sg in response.get("SecurityGroups", []):
            open_to_internet = []

            for rule in sg.get("IpPermissions", []):
                port = rule.get("FromPort", "all")
                protocol = rule.get("IpProtocol", "unknown")

                for ip_range in rule.get("IpRanges", []):
                    if ip_range.get("CidrIp") == "0.0.0.0/0":
                        open_to_internet.append(
                            {
                                "port": port,
                                "protocol": protocol,
                            }
                        )

                for ipv6_range in rule.get("Ipv6Ranges", []):
                    if ipv6_range.get("CidrIpv6") == "::/0":
                        already_added = any(
                            entry["port"] == port and entry["protocol"] == protocol
                            for entry in open_to_internet
                        )
                        if not already_added:
                            open_to_internet.append(
                                {
                                    "port": port,
                                    "protocol": protocol,
                                }
                            )
                        break

            security_groups.append(
                {
                    "id": sg.get("GroupId", ""),
                    "name": sg.get("GroupName", ""),
                    "description": sg.get("Description", ""),
                    "vpc_id": sg.get("VpcId"),
                    "open_to_internet": open_to_internet,
                    "is_dangerous": len(open_to_internet) > 0,
                }
            )

        return {
            "status": "ok",
            "count": len(security_groups),
            "security_groups": security_groups,
        }

    except NoCredentialsError:
        return {
            "status": "error",
            "error": "AWS credentials not found. Run 'aws configure' to set them up.",
            "count": 0,
            "security_groups": [],
        }
    except ClientError as error:
        return {
            "status": "error",
            "error": f"AWS API error: {error.response.get('Error', {}).get('Message', str(error))}",
            "count": 0,
            "security_groups": [],
        }
    except Exception as error:
        return {
            "status": "error",
            "error": f"Unexpected error: {str(error)}",
            "count": 0,
            "security_groups": [],
        }


def scan_vpc(region: str = "us-east-1", credentials: dict = None) -> dict:
    """
    Scan all VPCs (Virtual Private Clouds) in the given AWS region.

    For each VPC we also count how many subnets belong to it by calling
    describe_subnets() and filtering by VpcId.

    Returns a dict with:
      - status: "ok" or "error"
      - count: number of VPCs found
      - vpcs: list of dicts, each with id, name, cidr, is_default,
              state, subnet_count

    On any error, returns {"status": "error", "error": "...",
                           "count": 0, "vpcs": []}
    """

    try:
        ec2_client = (
            get_aws_session(credentials).client("ec2", region_name=region)
            if credentials
            else boto3.client("ec2", region_name=region)
        )

        # Get all VPCs in the region.
        vpc_response = ec2_client.describe_vpcs()

        subnet_response = ec2_client.describe_subnets()
        all_subnets = subnet_response.get("Subnets", [])

        vpcs = []

        for vpc in vpc_response.get("Vpcs", []):
            vpc_id = vpc.get("VpcId", "")

            name = ""
            for tag in vpc.get("Tags", []):
                if tag.get("Key") == "Name":
                    name = tag.get("Value", "")
                    break

            subnet_count = 0
            for subnet in all_subnets:
                if subnet.get("VpcId") == vpc_id:
                    subnet_count += 1

            vpcs.append(
                {
                    "id": vpc_id,
                    "name": name,
                    "cidr": vpc.get("CidrBlock", ""),
                    "is_default": vpc.get("IsDefault", False),
                    "state": vpc.get("State", ""),
                    "subnet_count": subnet_count,
                }
            )

        return {
            "status": "ok",
            "count": len(vpcs),
            "vpcs": vpcs,
        }

    except NoCredentialsError:
        return {
            "status": "error",
            "error": "AWS credentials not found. Run 'aws configure' to set them up.",
            "count": 0,
            "vpcs": [],
        }
    except ClientError as error:
        return {
            "status": "error",
            "error": f"AWS API error: {error.response.get('Error', {}).get('Message', str(error))}",
            "count": 0,
            "vpcs": [],
        }
    except Exception as error:
        return {
            "status": "error",
            "error": f"Unexpected error: {str(error)}",
            "count": 0,
            "vpcs": [],
        }
