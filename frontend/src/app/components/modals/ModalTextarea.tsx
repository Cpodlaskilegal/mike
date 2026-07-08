"use client";

export function ModalTextarea(
    props: React.TextareaHTMLAttributes<HTMLTextAreaElement>,
) {
    return (
        <textarea
            {...props}
            className={`w-full rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-800 placeholder-gray-400 outline-none transition-colors focus:border-gray-400 ${props.className ?? ""}`}
        />
    );
}
