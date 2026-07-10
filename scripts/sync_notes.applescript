on formatDate(theDate)
    set y to year of theDate as integer
    set m to month of theDate as integer
    set d to day of theDate as integer
    set s to time of theDate
    
    set hoursVal to (s div 3600) as integer
    set minutesVal to ((s mod 3600) div 60) as integer
    set secondsVal to (s mod 60) as integer
    
    -- pad with zero if needed
    set mStr to text -2 thru -1 of ("0" & m)
    set dStr to text -2 thru -1 of ("0" & d)
    set hStr to text -2 thru -1 of ("0" & hoursVal)
    set minStr to text -2 thru -1 of ("0" & minutesVal)
    set secStr to text -2 thru -1 of ("0" & secondsVal)
    
    return (y as string) & "-" & mStr & "-" & dStr & "T" & hStr & ":" & minStr & ":" & secStr
end formatDate

tell application "Notes"
    set noteList to ""
    set noteCount to count of notes
    repeat with i from 1 to noteCount
        try
            set currentNote to note i
            set noteTitle to name of currentNote
            set noteBody to body of currentNote
            set noteModDate to modification date of currentNote
            
            -- Format the date using our custom ISO formatter
            set dateString to my formatDate(noteModDate)
            
            set noteList to noteList & "---NOTE_START---" & "\n"
            set noteList to noteList & "TITLE: " & noteTitle & "\n"
            set noteList to noteList & "DATE: " & dateString & "\n"
            set noteList to noteList & "BODY: " & noteBody & "\n"
            set noteList to noteList & "---NOTE_END---" & "\n"
        end try
    end repeat
    return noteList
end tell
