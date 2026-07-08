"use client";

interface Option<T extends string> {
    value: T;
    label: string;
    icon?: React.ReactNode;
}

interface Props<T extends string> {
    value: T;
    options: Option<T>[];
    onChange: (value: T) => void;
    disabled?: boolean;
}

export function ModalSegmentedToggle<T extends string>({
    value,
    options,
    onChange,
    disabled = false,
}: Props<T>) {
    return (
        <div className="inline-flex rounded-lg border border-gray-200 bg-gray-50 p-1">
            {options.map((option) => (
                <button
                    key={option.value}
                    type="button"
                    disabled={disabled}
                    onClick={() => onChange(option.value)}
                    className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition-colors ${
                        value === option.value
                            ? "bg-white text-gray-900 shadow-sm"
                            : "text-gray-500 hover:text-gray-800"
                    } disabled:cursor-not-allowed disabled:opacity-50`}
                >
                    {option.icon}
                    {option.label}
                </button>
            ))}
        </div>
    );
}
