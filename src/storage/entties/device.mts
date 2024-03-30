export interface Device {
    id: number;
    certificate_thumbprint: string;
    certificate_subject: string;
    certificate_issuer: string;
    created_at: string;
    approved: boolean;
    enabled: boolean;
    device_group_id?: number;
}
