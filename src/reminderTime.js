export function localReminderInput(date=new Date()){
 const pad=v=>String(v).padStart(2,'0');return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
export function reminderUtc(value){
 const match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);if(!match)throw new Error('Choose a complete reminder date and time.');
 const [year,month,day,hour,minute]=match.slice(1).map(Number);if(year<1900||year>9998)throw new Error('Choose a supported reminder year.');const date=new Date(year,month-1,day,hour,minute);
 if(date.getFullYear()!==year||date.getMonth()!==month-1||date.getDate()!==day||date.getHours()!==hour||date.getMinutes()!==minute)throw new Error('This local time does not exist. Choose a valid calendar time in your time zone.');return date.toISOString();
}
