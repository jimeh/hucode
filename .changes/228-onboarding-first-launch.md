feat(onboarding): open setup on first desktop launch

New desktop installations open Hucode onboarding after Omni restores. Dismissal
and crashes preserve a resume point, while Finish and explicit Skip stop
automatic onboarding. The first folder can explicitly use the ordinary profile
from an eligible import; existing workbenches keep their profile and are focused.
