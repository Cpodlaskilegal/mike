import { MikeLayoutClient } from "./MikeLayoutClient";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function MikeLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return <MikeLayoutClient>{children}</MikeLayoutClient>;
}
