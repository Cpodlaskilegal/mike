"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LogOut, Check } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useUserProfile } from "@/contexts/UserProfileContext";
import {
    type AdminUser,
    deleteAccount,
    listAdminUsers,
    updateAdminUserRole,
} from "@/app/lib/docketApi";

export default function AccountPage() {
    const router = useRouter();
    const { user, signOut } = useAuth();
    const {
        profile,
        updateDisplayName,
        updateOrganisation,
        reloadProfile,
    } = useUserProfile();
    const [displayName, setDisplayName] = useState("");
    const [isSavingName, setIsSavingName] = useState(false);
    const [saved, setSaved] = useState(false);
    const [organisation, setOrganisation] = useState("");
    const [isSavingOrg, setIsSavingOrg] = useState(false);
    const [orgSaved, setOrgSaved] = useState(false);
    const [deleteConfirm, setDeleteConfirm] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [adminUsers, setAdminUsers] = useState<AdminUser[]>([]);
    const [isLoadingAdminUsers, setIsLoadingAdminUsers] = useState(false);
    const [adminUsersError, setAdminUsersError] = useState<string | null>(null);
    const [savingRoleFor, setSavingRoleFor] = useState<string | null>(null);

    useEffect(() => {
        if (profile?.displayName) {
            setDisplayName(profile.displayName);
        }
        if (profile?.organisation) {
            setOrganisation(profile.organisation);
        }
    }, [profile]);

    const loadAdminUsers = useCallback(async () => {
        if (profile?.role !== "admin") return;
        setIsLoadingAdminUsers(true);
        setAdminUsersError(null);
        try {
            setAdminUsers(await listAdminUsers());
        } catch (error) {
            setAdminUsersError(
                error instanceof Error
                    ? error.message
                    : "Failed to load users.",
            );
        } finally {
            setIsLoadingAdminUsers(false);
        }
    }, [profile?.role]);

    useEffect(() => {
        void loadAdminUsers();
    }, [loadAdminUsers]);

    const handleLogout = async () => {
        await signOut();
        router.push("/");
    };

    const handleDeleteAccount = async () => {
        setIsDeleting(true);
        try {
            await deleteAccount();
            await signOut();
            router.push("/");
        } catch {
            setIsDeleting(false);
            setDeleteConfirm(false);
            alert("Failed to delete account. Please try again.");
        }
    };

    const handleSaveDisplayName = async () => {
        setIsSavingName(true);
        const success = await updateDisplayName(displayName.trim());
        setIsSavingName(false);

        if (success) {
            setSaved(true);
            setTimeout(() => setSaved(false), 2000);
        } else {
            alert("Failed to update display name. Please try again.");
        }
    };

    const handleSaveOrganisation = async () => {
        setIsSavingOrg(true);
        const success = await updateOrganisation(organisation.trim());
        setIsSavingOrg(false);

        if (success) {
            setOrgSaved(true);
            setTimeout(() => setOrgSaved(false), 2000);
        } else {
            alert("Failed to update organisation. Please try again.");
        }
    };

    const handleRoleChange = async (
        targetUserId: string,
        role: "user" | "admin",
    ) => {
        setSavingRoleFor(targetUserId);
        setAdminUsersError(null);
        try {
            const updated = await updateAdminUserRole(targetUserId, role);
            setAdminUsers((prev) =>
                prev.map((adminUser) =>
                    adminUser.id === targetUserId
                        ? { ...adminUser, ...updated }
                        : adminUser,
                ),
            );
            if (updated.isCurrentUser) await reloadProfile();
        } catch (error) {
            setAdminUsersError(
                error instanceof Error
                    ? error.message
                    : "Failed to update user role.",
            );
        } finally {
            setSavingRoleFor(null);
        }
    };

    if (!user) return null;

    return (
        <div className="space-y-4">
            {/* Profile Settings */}
            <div className="pb-6">
                <div className="flex items-center gap-2 mb-4">
                    <h2 className="text-2xl font-medium font-serif">Profile</h2>
                </div>
                <div className="space-y-4">
                    <div>
                        <label className="text-sm text-gray-600 block mb-2">
                            Display Name
                        </label>
                        <div className="flex gap-2">
                            <Input
                                type="text"
                                value={displayName}
                                onChange={(e) => setDisplayName(e.target.value)}
                                placeholder="Enter your name"
                                className="flex-1"
                            />
                            <Button
                                onClick={handleSaveDisplayName}
                                disabled={
                                    isSavingName || !displayName.trim() || saved
                                }
                                className="min-w-[80px] transition-all bg-black hover:bg-gray-900 text-white"
                            >
                                {isSavingName ? (
                                    "Saving..."
                                ) : saved ? (
                                    <>
                                        <Check className="h-4 w-3" />
                                        Saved
                                    </>
                                ) : (
                                    "Save"
                                )}
                            </Button>
                        </div>
                    </div>
                    <div>
                        <label className="text-sm text-gray-600 block mb-2">
                            Organisation
                        </label>
                        <div className="flex gap-2">
                            <Input
                                type="text"
                                value={organisation}
                                onChange={(e) =>
                                    setOrganisation(e.target.value)
                                }
                                placeholder="Enter your organisation"
                                className="flex-1"
                            />
                            <Button
                                onClick={handleSaveOrganisation}
                                disabled={
                                    isSavingOrg ||
                                    organisation.trim() ===
                                        (profile?.organisation ?? "") ||
                                    orgSaved
                                }
                                className="min-w-[80px] transition-all bg-black hover:bg-gray-900 text-white"
                            >
                                {isSavingOrg ? (
                                    "Saving..."
                                ) : orgSaved ? (
                                    <>
                                        <Check className="h-4 w-3" />
                                        Saved
                                    </>
                                ) : (
                                    "Save"
                                )}
                            </Button>
                        </div>
                    </div>
                    <div>
                        <label className="text-sm text-gray-600 block mb-2">
                            Email
                        </label>
                        <p className="text-base">{user?.email}</p>
                    </div>
                </div>
            </div>

            {/* Plan */}
            <div className="py-6">
                <div className="flex items-center gap-2 mb-4">
                    <h2 className="text-2xl font-medium font-serif">
                        Usage Plan
                    </h2>
                </div>
                <div>
                    <p className="text-base font-medium text-gray-500 capitalize">
                        {profile?.tier || "Free"}
                    </p>
                </div>
            </div>

            {profile?.role === "admin" && (
                <div className="py-6">
                    <div className="mb-4 flex items-center justify-between gap-3">
                        <h2 className="text-2xl font-medium font-serif">
                            Users
                        </h2>
                        <Button
                            variant="outline"
                            onClick={loadAdminUsers}
                            disabled={isLoadingAdminUsers}
                            className="h-9"
                        >
                            {isLoadingAdminUsers ? "Loading..." : "Refresh"}
                        </Button>
                    </div>
                    {adminUsersError && (
                        <p className="mb-3 text-sm text-red-600">
                            {adminUsersError}
                        </p>
                    )}
                    <div className="overflow-x-auto rounded-lg border border-gray-200">
                        <table className="w-full min-w-[620px] text-left text-sm">
                            <thead className="border-b border-gray-200 bg-gray-50 text-xs uppercase text-gray-500">
                                <tr>
                                    <th className="px-3 py-2 font-medium">
                                        User
                                    </th>
                                    <th className="px-3 py-2 font-medium">
                                        Organisation
                                    </th>
                                    <th className="px-3 py-2 font-medium">
                                        Role
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {adminUsers.map((adminUser) => (
                                    <tr
                                        key={adminUser.id}
                                        className="border-b border-gray-100 last:border-b-0"
                                    >
                                        <td className="px-3 py-3 align-middle">
                                            <div className="font-medium text-gray-900">
                                                {adminUser.displayName ||
                                                    adminUser.email ||
                                                    "Unnamed user"}
                                                {adminUser.isCurrentUser
                                                    ? " (you)"
                                                    : ""}
                                            </div>
                                            <div className="text-xs text-gray-500">
                                                {adminUser.email}
                                            </div>
                                        </td>
                                        <td className="px-3 py-3 align-middle text-gray-600">
                                            {adminUser.organisation || "-"}
                                        </td>
                                        <td className="px-3 py-3 align-middle">
                                            <select
                                                value={adminUser.role}
                                                disabled={
                                                    savingRoleFor ===
                                                    adminUser.id
                                                }
                                                onChange={(event) =>
                                                    void handleRoleChange(
                                                        adminUser.id,
                                                        event.target.value as
                                                            | "user"
                                                            | "admin",
                                                    )
                                                }
                                                className="h-9 rounded-md border border-gray-300 bg-white px-2 text-sm"
                                            >
                                                <option value="user">
                                                    User
                                                </option>
                                                <option value="admin">
                                                    Admin
                                                </option>
                                            </select>
                                        </td>
                                    </tr>
                                ))}
                                {!isLoadingAdminUsers &&
                                    adminUsers.length === 0 && (
                                        <tr>
                                            <td
                                                colSpan={3}
                                                className="px-3 py-6 text-center text-gray-500"
                                            >
                                                No users found.
                                            </td>
                                        </tr>
                                    )}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* Actions */}
            <div className="py-6">
                <h2 className="text-2xl font-medium font-serif mb-4">
                    Actions
                </h2>
                <Button
                    variant="outline"
                    onClick={handleLogout}
                    className="w-full sm:w-auto"
                >
                    <LogOut className="h-4 w-4 mr-2" />
                    Sign Out
                </Button>
            </div>

            {/* Danger Zone */}
            <div className="py-6">
                <h2 className="text-2xl font-medium font-serif mb-1 text-red-600">
                    Danger Zone
                </h2>
                <p className="text-sm text-gray-500 mb-4">
                    Permanently delete your account and all associated data.
                    This action cannot be undone.
                </p>
                {deleteConfirm ? (
                    <div className="rounded-lg border border-red-200 bg-red-50 p-4 space-y-3 max-w-sm">
                        <p className="text-sm font-medium text-red-700">
                            Are you sure? This will permanently delete your
                            account.
                        </p>
                        <div className="flex gap-2">
                            <Button
                                variant="outline"
                                onClick={() => setDeleteConfirm(false)}
                                disabled={isDeleting}
                                className="text-sm"
                            >
                                Cancel
                            </Button>
                            <Button
                                onClick={handleDeleteAccount}
                                disabled={isDeleting}
                                className="text-sm bg-red-600 hover:bg-red-700 text-white"
                            >
                                {isDeleting ? "Deleting…" : "Delete Account"}
                            </Button>
                        </div>
                    </div>
                ) : (
                    <Button
                        variant="outline"
                        onClick={() => setDeleteConfirm(true)}
                        className="w-full sm:w-auto border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700"
                    >
                        Delete Account
                    </Button>
                )}
            </div>
        </div>
    );
}
