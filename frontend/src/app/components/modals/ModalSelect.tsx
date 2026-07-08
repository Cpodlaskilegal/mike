"use client";

interface Props {
    value: string;
    options: readonly string[];
    onChange: (value: string) => void;
    placeholder?: string;
}

export function ModalSelect({ value, options, onChange, placeholder }: Props) {
    return (
        <select
            value={value}
            onChange={(event) => onChange(event.target.value)}
            className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 outline-none transition-colors focus:border-gray-400"
        >
            {placeholder && <option value="">{placeholder}</option>}
            {options.map((option) => (
                <option key={option} value={option}>
                    {option}
                </option>
            ))}
        </select>
    );
}
