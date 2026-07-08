export function ModalFieldLabel({ children }: { children: React.ReactNode }) {
    return (
        <label className="mb-2 block text-sm font-medium text-gray-500">
            {children}
        </label>
    );
}
