import { DocketLayoutClient } from "./DocketLayoutClient";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function DocketLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return <DocketLayoutClient>{children}</DocketLayoutClient>;
}
